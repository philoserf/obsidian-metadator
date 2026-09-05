import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MetadataToolPlugin from "./main";
import {
  API_KEY_MAX_LENGTH,
  areFieldNamesDistinct,
  DEFAULT_SETTINGS,
  isModelId,
  MAX_BULK_FILES,
  MAX_CONTENT_TOKEN_LIMIT,
  MODEL_OPTION_LABELS,
  PROMPT_MAX_LENGTH,
  TRUNCATE_METHOD_LABELS,
  UPDATE_METHOD_LABELS,
  VALID_MODEL_OPTIONS,
  VALID_TRUNCATE_METHOD_OPTIONS,
  VALID_UPDATE_METHOD_OPTIONS,
} from "./settings";

// `max` is required rather than optional: a bounded parser named "strict
// positive int" would be lying about what it enforces.
export function parseBoundedPositiveInt(
  value: string,
  max: number,
): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n > 0 && n <= max ? n : null;
}

// Two commit strategies, because the fields split into two kinds.
//
// Fields whose validation can only judge a finished value — the numeric ones,
// the model id, the frontmatter field names — commit on blur. Validating as the
// user types rejects the value on the way to a good one: clearing the box is the
// first keystroke of almost every edit, and an empty box is invalid, so changing
// 500 to 300 used to fire a Notice and snap the old value back before a digit
// was typed (#203). The Model field already worked this way; the rest did not.
//
// Free-text fields update settings in memory immediately and debounce only the
// disk write, so typing a 1000-character prompt is one save rather than a
// thousand (#177). Blur alone would risk losing the edit if the tab is closed
// without the field ever losing focus.
//
// Both register a flush that hide() runs, so an edit is never stranded by
// closing the settings tab.
interface PendingCommit {
  flush: () => void;
}

interface EditableText {
  getValue(): string;
  setValue(value: string): void;
  inputEl: HTMLInputElement | HTMLTextAreaElement;
}

function commitOnBlur(
  text: EditableText,
  commit: () => void | Promise<void>,
): PendingCommit {
  const run = () => {
    void commit();
  };
  text.inputEl.addEventListener("blur", run);
  return { flush: run };
}

export const SETTINGS_SAVE_DEBOUNCE_MS = 400;

// Extracted so the timing is testable without rendering a settings tab.
export function createDebouncer(
  commit: () => void,
  delayMs: number = SETTINGS_SAVE_DEBOUNCE_MS,
): { schedule: () => void; flush: () => void; pending: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        commit();
      }, delayMs);
    },
    // Runs the pending commit now. A no-op when nothing is pending, so hide()
    // can call it unconditionally without writing settings that did not change.
    flush() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      commit();
    },
    pending() {
      return timer !== undefined;
    },
  };
}

export class MetadataToolSettingTab extends PluginSettingTab {
  plugin: MetadataToolPlugin;
  // Flushed and cleared by hide(), and cleared again by display() before it
  // re-renders — otherwise a flush would point at an input that no longer
  // exists.
  private pending: PendingCommit[] = [];

  constructor(app: App, plugin: MetadataToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian does not await hide(), so each flush is fire-and-forget.
  hide(): void {
    for (const p of this.pending) p.flush();
    this.pending = [];
    super.hide();
  }

  // The three field-name settings differ only in which key they write and what
  // the collision Notice calls the field, so they share one builder. Returns
  // the Setting because the caller needs it for setDisabled().
  private addFieldNameSetting(
    containerEl: HTMLElement,
    label: string,
    key: "tagsFieldName" | "descriptionFieldName" | "titleFieldName",
  ): Setting {
    return new Setting(containerEl)
      .setName(`${label} Field Name`)
      .setDesc(`Frontmatter field name for ${label.toLowerCase()}`)
      .addText((text) => {
        text.setValue(this.plugin.settings[key]);
        this.pending.push(
          commitOnBlur(text, async () => {
            // Trimmed to match settingsMigrate's readString(nonEmpty), which
            // treats a whitespace-only name as absent. Without it " " was
            // truthy, appeared to stick, wrote a malformed YAML key, then
            // silently reverted on the next plugin load (#186).
            const name = text.getValue().trim() || DEFAULT_SETTINGS[key];
            if (name === this.plugin.settings[key]) {
              // Still normalize the box, so " tags " does not sit there
              // looking like an uncommitted edit.
              text.setValue(name);
              return;
            }
            const candidate = { ...this.plugin.settings };
            candidate[key] = name;
            if (!areFieldNamesDistinct(candidate)) {
              new Notice(
                `${label} field name must differ from the other frontmatter field names`,
              );
              text.setValue(this.plugin.settings[key]);
              return;
            }
            this.plugin.settings[key] = name;
            text.setValue(name);
            await this.plugin.saveSettings();
          }),
        );
      });
  }

  private addBoundedIntSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    noticeLabel: string,
    key: "maxBulkFiles" | "contentTokenLimit",
    max: number,
  ): Setting {
    return new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setValue(this.plugin.settings[key].toString());
        this.pending.push(
          commitOnBlur(text, async () => {
            const parsed = parseBoundedPositiveInt(text.getValue(), max);
            if (parsed === null) {
              new Notice(
                `${noticeLabel} must be a positive integer up to ${max}`,
              );
              text.setValue(this.plugin.settings[key].toString());
              return;
            }
            // Normalize before the equality check, so "0500" tidies itself
            // even though it commits nothing.
            text.setValue(parsed.toString());
            if (parsed === this.plugin.settings[key]) return;
            this.plugin.settings[key] = parsed;
            await this.plugin.saveSettings();
          }),
        );
      });
  }

  private addPromptSetting(
    containerEl: HTMLElement,
    label: string,
    desc: string,
    key: "tagsPrompt" | "descriptionPrompt" | "titlePrompt",
    save: PendingCommit & { schedule: () => void },
  ): Setting {
    return new Setting(containerEl)
      .setName(`${label} Prompt`)
      .setDesc(desc)
      .addTextArea((text) => {
        text.setValue(this.plugin.settings[key]).onChange((value) => {
          // The length check stays immediate — it can judge a partial value,
          // unlike the blur-committed fields. Only the disk write is deferred.
          if (value.length > PROMPT_MAX_LENGTH) {
            new Notice(
              `${label} prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
            );
            text.setValue(this.plugin.settings[key]);
            return;
          }
          this.plugin.settings[key] = value;
          save.schedule();
        });
        text.inputEl.setAttr("rows", "3");
      });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.pending = [];

    // One debouncer for every free-text field, not one each: they all run the
    // same commit, so a burst that crosses fields collapses into a single
    // write and hide() flushes one timer instead of racing four saveData
    // calls against each other.
    const save = createDebouncer(() => {
      void this.plugin.saveSettings();
    });
    this.pending.push(save);

    // Anthropic API Settings
    new Setting(containerEl).setName("Anthropic API Settings").setHeading();

    containerEl.createEl("p", {
      text: "Note: When you run the metadata command, your note content is sent to the Anthropic API for processing. No data is stored by Anthropic beyond the API request.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        "Your Anthropic API key. Get one at console.anthropic.com (requires an account with billing enabled)",
      )
      .addText((text) => {
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange((value) => {
            if (value.length > API_KEY_MAX_LENGTH) {
              new Notice(
                `API key cannot exceed ${API_KEY_MAX_LENGTH} characters`,
              );
              text.setValue(this.plugin.settings.anthropicApiKey);
              return;
            }
            this.plugin.settings.anthropicApiKey = value;
            save.schedule();
          });
        text.inputEl.type = "password";
      });

    // A text input backed by a datalist rather than a dropdown: the known
    // models autocomplete, but a model released after this build can be typed
    // in without waiting for a plugin update.
    const modelListId = "metadator-model-options";
    const modelList = containerEl.createEl("datalist");
    modelList.id = modelListId;
    for (const model of VALID_MODEL_OPTIONS) {
      const option = modelList.createEl("option");
      option.value = model;
      option.label = MODEL_OPTION_LABELS[model];
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Model to use for metadata generation. Pick a suggestion or type any Anthropic model id.",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.anthropicModel)
          .setValue(this.plugin.settings.anthropicModel);
        text.inputEl.setAttribute("list", modelListId);
        // Every prefix of a model id ("claude-fable-5-") is itself malformed,
        // which is why this field has always committed on blur.
        this.pending.push(
          commitOnBlur(text, async () => {
            const model = text.getValue().trim();
            if (model === this.plugin.settings.anthropicModel) return;
            if (!isModelId(model)) {
              new Notice(
                "Model must be an Anthropic model id, e.g. claude-sonnet-5",
              );
              text.setValue(this.plugin.settings.anthropicModel);
              return;
            }
            this.plugin.settings.anthropicModel = model;
            await this.plugin.saveSettings();
          }),
        );
      });

    new Setting(containerEl)
      .setName("Debug Logging")
      .setDesc(
        "Log prompts and responses to the developer console (View → Toggle Developer Tools)",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          }),
      );

    // Update Settings
    new Setting(containerEl).setName("Update Settings").setHeading();

    new Setting(containerEl)
      .setName("Update Method")
      .setDesc(
        "Always Regenerate: regenerate on every command; Preserve Existing: only generate empty fields",
      )
      .addDropdown((dropdown) => {
        for (const method of VALID_UPDATE_METHOD_OPTIONS) {
          dropdown.addOption(method, UPDATE_METHOD_LABELS[method]);
        }
        dropdown
          .setValue(this.plugin.settings.updateMethod)
          .onChange(async (value) => {
            this.plugin.settings.updateMethod = value as
              | "always_regenerate"
              | "preserve_existing";
            await this.plugin.saveSettings();
          });
      });

    this.addBoundedIntSetting(
      containerEl,
      "Max Bulk Files",
      "Hard limit on files-that-will-change in a single bulk run. Above this, the confirm dialog requires explicit override.",
      "Max bulk files",
      "maxBulkFiles",
      MAX_BULK_FILES,
    );

    new Setting(containerEl)
      .setName("Truncate Content")
      .setDesc("Limit content sent to API to reduce costs")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.truncateContent)
          .onChange(async (value) => {
            this.plugin.settings.truncateContent = value;
            await this.plugin.saveSettings();
            contentTokenLimitSetting.setDisabled(!value);
            truncateMethodSetting.setDisabled(!value);
          }),
      );

    const contentTokenLimitSetting = this.addBoundedIntSetting(
      containerEl,
      "Content Token Limit",
      "Maximum number of tokens of note content sent to the API",
      "Content token limit",
      "contentTokenLimit",
      MAX_CONTENT_TOKEN_LIMIT,
    );

    const truncateMethodSetting = new Setting(containerEl)
      .setName("Truncate Method")
      .setDesc("How to truncate long content")
      .addDropdown((dropdown) => {
        for (const method of VALID_TRUNCATE_METHOD_OPTIONS) {
          dropdown.addOption(method, TRUNCATE_METHOD_LABELS[method]);
        }
        dropdown
          .setValue(this.plugin.settings.truncateMethod)
          .onChange(async (value) => {
            this.plugin.settings.truncateMethod = value as
              | "head_only"
              | "head_tail"
              | "heading";
            await this.plugin.saveSettings();
          });
      });

    contentTokenLimitSetting.setDisabled(!this.plugin.settings.truncateContent);
    truncateMethodSetting.setDisabled(!this.plugin.settings.truncateContent);

    // Tags Settings
    new Setting(containerEl).setName("Tags Settings").setHeading();

    this.addFieldNameSetting(containerEl, "Tags", "tagsFieldName");
    this.addPromptSetting(
      containerEl,
      "Tags",
      `Instructions for tag generation (max ${PROMPT_MAX_LENGTH} chars)`,
      "tagsPrompt",
      save,
    );

    // Description Settings
    new Setting(containerEl).setName("Description Settings").setHeading();

    this.addFieldNameSetting(
      containerEl,
      "Description",
      "descriptionFieldName",
    );
    this.addPromptSetting(
      containerEl,
      "Description",
      `Instructions for description generation (max ${PROMPT_MAX_LENGTH} chars)`,
      "descriptionPrompt",
      save,
    );

    // Title Settings
    new Setting(containerEl).setName("Title Settings").setHeading();

    new Setting(containerEl)
      .setName("Enable Title")
      .setDesc("Generate title metadata")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableTitle)
          .onChange(async (value) => {
            this.plugin.settings.enableTitle = value;
            await this.plugin.saveSettings();
            titleFieldNameSetting.setDisabled(!value);
            titlePromptSetting.setDisabled(!value);
          }),
      );

    const titleFieldNameSetting = this.addFieldNameSetting(
      containerEl,
      "Title",
      "titleFieldName",
    );
    const titlePromptSetting = this.addPromptSetting(
      containerEl,
      "Title",
      `Instructions for title generation (max ${PROMPT_MAX_LENGTH} chars)`,
      "titlePrompt",
      save,
    );

    titleFieldNameSetting.setDisabled(!this.plugin.settings.enableTitle);
    titlePromptSetting.setDisabled(!this.plugin.settings.enableTitle);
  }
}
