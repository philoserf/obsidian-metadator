import {
  type App,
  PluginSettingTab,
  SecretComponent,
  type SettingDefinitionItem,
} from "obsidian";
import type MetadataToolPlugin from "./main";
import {
  areFieldNamesDistinct,
  DEFAULT_SETTINGS,
  isModelId,
  MAX_BULK_FILES,
  MAX_CONTENT_TOKEN_LIMIT,
  type MetadataToolSettings,
  MODEL_OPTION_LABELS,
  PROMPT_MAX_LENGTH,
  SCALAR_POLICY_LABELS,
  TAGS_POLICY_LABELS,
  TRUNCATE_METHOD_LABELS,
} from "./settings";
import { migrateSettings } from "./settingsMigrate";

export const SETTINGS_SAVE_DEBOUNCE_MS = 400;

// Extracted so the timing is testable without rendering a settings tab.
export function createDebouncer(
  commit: () => void,
  delayMs: number = SETTINGS_SAVE_DEBOUNCE_MS,
): { schedule: () => void; flush: () => void } {
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
  };
}

type FieldNameKey = "tagsFieldName" | "descriptionFieldName" | "titleFieldName";
type PromptKey = "tagsPrompt" | "descriptionPrompt" | "titlePrompt";

// Declarative settings (Obsidian 1.13.0, #282). Obsidian renders the
// definitions, indexes every row for settings search, and hands each control
// change to setControlValue. `validate` rejects a value inline and stores
// nothing — which also retires #203's snap-back: a half-typed value now shows
// a message instead of being reverted before the user finishes typing.
export class MetadataToolSettingTab extends PluginSettingTab {
  plugin: MetadataToolPlugin;

  // One debouncer for every field: a burst of keystrokes in a prompt is one
  // disk write, not one per character (#177). Settings change in memory at
  // once; hide() flushes, so closing the tab never strands an edit.
  private readonly save = createDebouncer(() => {
    void this.plugin.saveSettings();
  });

  constructor(app: App, plugin: MetadataToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Obsidian does not await hide(), so the flush is fire-and-forget.
  override hide(): void {
    this.save.flush();
    super.hide();
  }

  // Every write goes through migrateSettings, the path a reload takes, so a
  // control stores exactly what the next load would produce: a field name is
  // trimmed, an emptied prompt falls back to its default. The default
  // implementation would store the raw value.
  override setControlValue(key: string, value: unknown): void {
    const result = migrateSettings({ ...this.plugin.settings, [key]: value });
    if (result.kind !== "ok") return;
    this.plugin.settings = result.settings;
    this.save.schedule();
    // The truncate and title toggles disable other rows.
    this.refreshDomState();
  }

  private fieldName(
    label: string,
    key: FieldNameKey,
    disabled?: () => boolean,
  ) {
    return {
      name: `${label} field name`,
      desc: `Frontmatter field name for ${label.toLowerCase()}.`,
      control: {
        type: "text" as const,
        key,
        placeholder: DEFAULT_SETTINGS[key],
        ...(disabled && { disabled }),
        // The three names must differ, or one field's write clobbers
        // another's in the note (#200). Checked as if titles were on: an
        // inert title name that collides would be reset by the load path the
        // moment it was stored (#248), so it is refused here instead.
        validate: (value: string) =>
          areFieldNamesDistinct({
            ...this.plugin.settings,
            [key]: value.trim() || DEFAULT_SETTINGS[key],
            enableTitle: true,
          })
            ? undefined
            : `Must differ from the other frontmatter field names.`,
      },
    };
  }

  private prompt(label: string, key: PromptKey, disabled?: () => boolean) {
    return {
      name: `${label} prompt`,
      desc: `Instructions for ${label.toLowerCase()} generation, at most ${PROMPT_MAX_LENGTH} characters.`,
      control: {
        type: "textarea" as const,
        key,
        ...(disabled && { disabled }),
        validate: (value: string) =>
          value.length > PROMPT_MAX_LENGTH
            ? `At most ${PROMPT_MAX_LENGTH} characters.`
            : undefined,
      },
    };
  }

  private boundedInt(max: number) {
    return (value: number) =>
      Number.isInteger(value) && value > 0 && value <= max
        ? undefined
        : `A whole number from 1 to ${max}.`;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = (): MetadataToolSettings => this.plugin.settings;
    const truncateOff = () => !settings().truncateContent;
    const titleOff = () => !settings().enableTitle;

    return [
      {
        type: "group",
        heading: "Anthropic API",
        items: [
          {
            name: "API key",
            desc: "Your Anthropic API key, from console.anthropic.com. Kept in Obsidian's keychain on this device; only its name is saved with the plugin's settings, so each device that generates metadata needs it chosen once. Running a command sends the note's content to the Anthropic API.",
            // No declarative secret control exists, so this row is drawn by
            // hand; it saves through the same setControlValue as the rest.
            render: (setting) => {
              new SecretComponent(this.app, setting.controlEl)
                .setValue(settings().anthropicApiKeySecret)
                .onChange((id) =>
                  this.setControlValue("anthropicApiKeySecret", id),
                );
            },
          },
          {
            name: "Model",
            desc: "Pick a suggestion or type any Anthropic model id. A partial id is not saved.",
            aliases: Object.values(MODEL_OPTION_LABELS),
            // A text input backed by a datalist rather than a dropdown, so a
            // model released after this build can be typed in. No declarative
            // control offers suggestions, so this row is drawn by hand.
            render: (setting) => {
              setting.addText((text) => {
                const listId = "metadator-model-options";
                const list = setting.controlEl.createEl("datalist");
                list.id = listId;
                for (const [model, label] of Object.entries(
                  MODEL_OPTION_LABELS,
                )) {
                  const option = list.createEl("option");
                  option.value = model;
                  option.label = label;
                }
                text.inputEl.setAttribute("list", listId);
                text
                  .setPlaceholder(DEFAULT_SETTINGS.anthropicModel)
                  .setValue(settings().anthropicModel)
                  .onChange((value) => {
                    // Every prefix of a model id is itself malformed, so only
                    // a well-formed id is stored.
                    const model = value.trim();
                    if (isModelId(model)) {
                      this.setControlValue("anthropicModel", model);
                    }
                  });
              });
            },
          },
          {
            name: "Debug logging",
            desc: "Log prompts and responses to the developer console (View → Toggle Developer Tools).",
            control: { type: "toggle", key: "debugLogging" },
          },
        ],
      },
      {
        type: "group",
        heading: "Write policy",
        items: [
          {
            name: "Tags write policy",
            desc: "Always Regenerate: replace the list with the reconciled set the model returns, keeping the tags that still fit and dropping those that no longer do; Merge: add to what is there and never remove; Preserve Existing: only write when the field is empty.",
            control: {
              type: "dropdown",
              key: "tagsPolicy",
              options: TAGS_POLICY_LABELS,
            },
          },
          {
            name: "Description write policy",
            desc: "Always Regenerate: replace on every run; Preserve Existing: only write when the field is empty.",
            control: {
              type: "dropdown",
              key: "descriptionPolicy",
              options: SCALAR_POLICY_LABELS,
            },
          },
          {
            name: "Title write policy",
            desc: "Always Regenerate: replace on every run; Preserve Existing: only write when the field is empty. Preserve is the default because a title is often kept in sync by another plugin or relied on by a publisher.",
            control: {
              type: "dropdown",
              key: "titlePolicy",
              options: SCALAR_POLICY_LABELS,
            },
          },
          {
            name: "Max bulk files",
            desc: "Confirmation gate on files-that-will-change in a single bulk run. Above this, the run is refused unless you tick the override in the confirm dialog.",
            control: {
              type: "number",
              key: "maxBulkFiles",
              min: 1,
              max: MAX_BULK_FILES,
              step: 1,
              validate: this.boundedInt(MAX_BULK_FILES),
            },
          },
          {
            name: "Truncate content",
            desc: "Limit content sent to the API to reduce costs.",
            control: { type: "toggle", key: "truncateContent" },
          },
          {
            name: "Content token limit",
            desc: "Maximum number of tokens of note content sent to the API.",
            control: {
              type: "number",
              key: "contentTokenLimit",
              min: 1,
              max: MAX_CONTENT_TOKEN_LIMIT,
              step: 1,
              validate: this.boundedInt(MAX_CONTENT_TOKEN_LIMIT),
              disabled: truncateOff,
            },
          },
          {
            name: "Truncate method",
            desc: "How to truncate long content.",
            control: {
              type: "dropdown",
              key: "truncateMethod",
              options: TRUNCATE_METHOD_LABELS,
              disabled: truncateOff,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Tags",
        items: [
          this.fieldName("Tags", "tagsFieldName"),
          this.prompt("Tags", "tagsPrompt"),
        ],
      },
      {
        type: "group",
        heading: "Description",
        items: [
          this.fieldName("Description", "descriptionFieldName"),
          this.prompt("Description", "descriptionPrompt"),
        ],
      },
      {
        type: "group",
        heading: "Title",
        items: [
          {
            name: "Enable title",
            desc: "Generate title metadata.",
            control: { type: "toggle", key: "enableTitle" },
          },
          this.fieldName("Title", "titleFieldName", titleOff),
          this.prompt("Title", "titlePrompt", titleOff),
        ],
      },
    ];
  }
}
