import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MetadataToolPlugin from "./main";
import {
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
  // Cleared by display(), which empties containerEl — otherwise a re-render
  // would leave flushes pointing at inputs that no longer exist.
  private pending: PendingCommit[] = [];

  constructor(app: App, plugin: MetadataToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian does not await hide(), so each flush is fire-and-forget.
  hide(): void {
    for (const p of this.pending) p.flush();
    this.pending = [];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.pending = [];

    const saveLater = () => {
      const d = createDebouncer(() => {
        void this.plugin.saveSettings();
      });
      this.pending.push(d);
      return d;
    };

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
        const save = saveLater();
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange((value) => {
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

    new Setting(containerEl)
      .setName("Max Bulk Files")
      .setDesc(
        "Hard limit on files-that-will-change in a single bulk run. Above this, the confirm dialog requires explicit override.",
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.maxBulkFiles.toString());
        this.pending.push(
          commitOnBlur(text, async () => {
            const parsed = parseBoundedPositiveInt(
              text.getValue(),
              MAX_BULK_FILES,
            );
            if (parsed === null) {
              new Notice(
                `Max bulk files must be a positive integer up to ${MAX_BULK_FILES}`,
              );
              text.setValue(this.plugin.settings.maxBulkFiles.toString());
              return;
            }
            if (parsed === this.plugin.settings.maxBulkFiles) return;
            this.plugin.settings.maxBulkFiles = parsed;
            await this.plugin.saveSettings();
          }),
        );
      });

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

    const contentTokenLimitSetting = new Setting(containerEl)
      .setName("Content Token Limit")
      .setDesc("Maximum number of tokens of note content sent to the API")
      .addText((text) => {
        text.setValue(this.plugin.settings.contentTokenLimit.toString());
        this.pending.push(
          commitOnBlur(text, async () => {
            const parsed = parseBoundedPositiveInt(
              text.getValue(),
              MAX_CONTENT_TOKEN_LIMIT,
            );
            if (parsed === null) {
              new Notice(
                `Content token limit must be a positive integer up to ${MAX_CONTENT_TOKEN_LIMIT}`,
              );
              text.setValue(this.plugin.settings.contentTokenLimit.toString());
              return;
            }
            if (parsed === this.plugin.settings.contentTokenLimit) return;
            this.plugin.settings.contentTokenLimit = parsed;
            await this.plugin.saveSettings();
          }),
        );
      });

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

    new Setting(containerEl)
      .setName("Tags Field Name")
      .setDesc("Frontmatter field name for tags")
      .addText((text) => {
        text.setValue(this.plugin.settings.tagsFieldName);
        this.pending.push(
          commitOnBlur(text, async () => {
            const name = text.getValue() || DEFAULT_SETTINGS.tagsFieldName;
            if (name === this.plugin.settings.tagsFieldName) return;
            this.plugin.settings.tagsFieldName = name;
            text.setValue(name);
            await this.plugin.saveSettings();
          }),
        );
      });

    new Setting(containerEl)
      .setName("Tags Prompt")
      .setDesc(
        `Instructions for tag generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        const save = saveLater();
        text.setValue(this.plugin.settings.tagsPrompt).onChange((value) => {
          // The length check stays immediate — it can judge a partial value,
          // unlike the blur-committed fields. Only the disk write is deferred.
          if (value.length > PROMPT_MAX_LENGTH) {
            new Notice(
              `Tags prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
            );
            text.setValue(this.plugin.settings.tagsPrompt);
            return;
          }
          this.plugin.settings.tagsPrompt = value;
          save.schedule();
        });
        text.inputEl.setAttr("rows", "3");
      });

    // Description Settings
    new Setting(containerEl).setName("Description Settings").setHeading();

    new Setting(containerEl)
      .setName("Description Field Name")
      .setDesc("Frontmatter field name for description")
      .addText((text) => {
        text.setValue(this.plugin.settings.descriptionFieldName);
        this.pending.push(
          commitOnBlur(text, async () => {
            const name =
              text.getValue() || DEFAULT_SETTINGS.descriptionFieldName;
            if (name === this.plugin.settings.descriptionFieldName) return;
            this.plugin.settings.descriptionFieldName = name;
            text.setValue(name);
            await this.plugin.saveSettings();
          }),
        );
      });

    new Setting(containerEl)
      .setName("Description Prompt")
      .setDesc(
        `Instructions for description generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        const save = saveLater();
        text
          .setValue(this.plugin.settings.descriptionPrompt)
          .onChange((value) => {
            // The length check stays immediate — it can judge a partial value,
            // unlike the blur-committed fields. Only the disk write is deferred.
            if (value.length > PROMPT_MAX_LENGTH) {
              new Notice(
                `Description prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
              );
              text.setValue(this.plugin.settings.descriptionPrompt);
              return;
            }
            this.plugin.settings.descriptionPrompt = value;
            save.schedule();
          });
        text.inputEl.setAttr("rows", "3");
      });

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

    const titleFieldNameSetting = new Setting(containerEl)
      .setName("Title Field Name")
      .setDesc("Frontmatter field name for title")
      .addText((text) => {
        text.setValue(this.plugin.settings.titleFieldName);
        this.pending.push(
          commitOnBlur(text, async () => {
            const name = text.getValue() || DEFAULT_SETTINGS.titleFieldName;
            if (name === this.plugin.settings.titleFieldName) return;
            this.plugin.settings.titleFieldName = name;
            text.setValue(name);
            await this.plugin.saveSettings();
          }),
        );
      });

    const titlePromptSetting = new Setting(containerEl)
      .setName("Title Prompt")
      .setDesc(
        `Instructions for title generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        const save = saveLater();
        text.setValue(this.plugin.settings.titlePrompt).onChange((value) => {
          // The length check stays immediate — it can judge a partial value,
          // unlike the blur-committed fields. Only the disk write is deferred.
          if (value.length > PROMPT_MAX_LENGTH) {
            new Notice(
              `Title prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
            );
            text.setValue(this.plugin.settings.titlePrompt);
            return;
          }
          this.plugin.settings.titlePrompt = value;
          save.schedule();
        });
        text.inputEl.setAttr("rows", "3");
      });

    titleFieldNameSetting.setDisabled(!this.plugin.settings.enableTitle);
    titlePromptSetting.setDisabled(!this.plugin.settings.enableTitle);
  }
}
