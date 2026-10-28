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
  MAX_CONTENT_TOKEN_LIMIT,
  type MetadataToolSettings,
  MODEL_OPTION_LABELS,
  PROMPT_MAX_LENGTH,
  TRUNCATE_METHOD_LABELS,
  WRITE_POLICY_LABELS,
} from "./settings";
import { migrateSettings } from "./settingsMigrate";
import { SHARED_KEY_ID } from "./settingsStore";

export const SETTINGS_SAVE_DEBOUNCE_MS = 400;

// Extracted so the timing is testable without rendering a settings tab.
export function createDebouncer(
  commit: () => void,
  delayMs: number = SETTINGS_SAVE_DEBOUNCE_MS,
): { schedule: () => void; flush: () => void; cancel: () => void } {
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
    // Drops the pending commit without running it.
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// The name a new key is suggested under. Generic on purpose, so another plugin
// that needs an Anthropic key can pick the same secret.
const SUGGESTED_KEY_NAME = SHARED_KEY_ID;

/**
 * What the API key row says about the secret it points at. The plugin row and
 * Settings → Keychain are separate screens, and the secret's name syncs with
 * data.json while its value stays on the device that stored it — so on a
 * second device the row holds a name the keychain does not have, and nothing
 * else says what to call the secret. Reads names only, never values.
 */
export function apiKeyStatus(id: string, onDevice: readonly string[]): string {
  if (!id) {
    return `Choose or create a keychain secret holding your Anthropic API key. Naming it "${SUGGESTED_KEY_NAME}" lets other plugins use the same key.`;
  }
  return onDevice.includes(id)
    ? `Uses the keychain secret "${id}".`
    : `This device's keychain has no secret named "${id}". Add your key in Settings → Keychain under that name, or choose another secret here.`;
}

type FieldNameKey = "descriptionFieldName" | "titleFieldName";
type PromptKey = "descriptionPrompt" | "titlePrompt";

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

  // Sync replaced data.json under a running plugin. A save still pending from
  // an edit here would fire after the reload and write the adopted settings
  // straight back — nothing lost, but a write the change did not need, which
  // Sync then carries to every other device. So the save is dropped before the
  // reload, not flushed (flushing would clobber the incoming file), and the
  // tab re-renders from what was adopted. An edit made here in the debounce
  // window loses to the synced file.
  async reloadSettings(load: () => Promise<void>): Promise<void> {
    this.save.cancel();
    await load();
    this.update();
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
    // The truncate and field toggles disable other rows.
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
        // The two names must differ, or one field's write clobbers the
        // other's in the note (#200). Checked as if every field were on: an
        // inert name that collides would be reset by the load path the moment
        // it was stored (#248), so it is refused here instead.
        validate: (value: string) =>
          areFieldNamesDistinct({
            ...this.plugin.settings,
            [key]: value.trim() || DEFAULT_SETTINGS[key],
            enableDescription: true,
            enableTitle: true,
          })
            ? undefined
            : `Must differ from the other frontmatter field name.`,
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
    // A field that is off is never asked for or written, so its name, prompt
    // and policy rows have nothing to configure (#305).
    const descriptionOff = () => !settings().enableDescription;
    const titleOff = () => !settings().enableTitle;

    return [
      {
        type: "group",
        heading: "Anthropic API",
        items: [
          {
            name: "API key",
            desc: `${apiKeyStatus(
              settings().anthropicApiKeySecret,
              this.app.secretStorage.listSecrets(),
            )} Get a key at console.anthropic.com. Keychain secrets stay on the device that stores them; only the name syncs. Running a command sends the note's content to the Anthropic API.`,
            // No declarative secret control exists, so this row is drawn by
            // hand; it saves through the same setControlValue as the rest.
            render: (setting) => {
              new SecretComponent(this.app, setting.controlEl)
                .setValue(settings().anthropicApiKeySecret)
                .onChange((id) => {
                  this.setControlValue("anthropicApiKeySecret", id);
                  // Re-render so the description reports the new secret.
                  this.update();
                });
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
            name: "Description write policy",
            desc: "Always Regenerate: replace on every run; Preserve Existing: only write when the field is empty.",
            control: {
              type: "dropdown",
              key: "descriptionPolicy",
              options: WRITE_POLICY_LABELS,
              disabled: descriptionOff,
            },
          },
          {
            name: "Title write policy",
            desc: "Always Regenerate: replace on every run; Preserve Existing: only write when the field is empty. Preserve is the default because a title is often kept in sync by another plugin or relied on by a publisher.",
            control: {
              type: "dropdown",
              key: "titlePolicy",
              options: WRITE_POLICY_LABELS,
              disabled: titleOff,
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
        heading: "Description",
        items: [
          {
            name: "Enable description",
            desc: "Generate description metadata. When off, a description is not requested and an existing value is left as it is.",
            control: { type: "toggle", key: "enableDescription" },
          },
          this.fieldName("Description", "descriptionFieldName", descriptionOff),
          this.prompt("Description", "descriptionPrompt", descriptionOff),
        ],
      },
      {
        type: "group",
        heading: "Title",
        items: [
          {
            name: "Enable title",
            desc: "Generate title metadata. When off, a title is not requested and an existing value is left as it is.",
            control: { type: "toggle", key: "enableTitle" },
          },
          this.fieldName("Title", "titleFieldName", titleOff),
          this.prompt("Title", "titlePrompt", titleOff),
        ],
      },
    ];
  }
}
