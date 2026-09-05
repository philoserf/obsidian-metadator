import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MetadataToolPlugin from "./main";
import {
  DEFAULT_SETTINGS,
  isModelId,
  MODEL_OPTION_LABELS,
  PROMPT_MAX_LENGTH,
  TRUNCATE_METHOD_LABELS,
  UPDATE_METHOD_LABELS,
  VALID_MODEL_OPTIONS,
  VALID_TRUNCATE_METHOD_OPTIONS,
  VALID_UPDATE_METHOD_OPTIONS,
} from "./settings";

export function parseStrictPositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n > 0 ? n : null;
}

export class MetadataToolSettingTab extends PluginSettingTab {
  plugin: MetadataToolPlugin;

  constructor(app: App, plugin: MetadataToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value;
            await this.plugin.saveSettings();
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
        // Commit on blur rather than per keystroke: every prefix of a model id
        // ("claude-fable-5-") is itself malformed, so validating as the user
        // types would reject the value on the way to a good one.
        text.inputEl.addEventListener("blur", async () => {
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
        });
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
      .addText((text) =>
        text
          .setValue(this.plugin.settings.maxBulkFiles.toString())
          .onChange(async (value) => {
            const parsed = parseStrictPositiveInt(value);
            if (parsed === null) {
              new Notice("Max bulk files must be a positive integer");
              text.setValue(this.plugin.settings.maxBulkFiles.toString());
              return;
            }
            this.plugin.settings.maxBulkFiles = parsed;
            await this.plugin.saveSettings();
          }),
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

    const contentTokenLimitSetting = new Setting(containerEl)
      .setName("Content Token Limit")
      .setDesc("Maximum number of tokens of note content sent to the API")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.contentTokenLimit.toString())
          .onChange(async (value) => {
            const parsed = parseStrictPositiveInt(value);
            if (parsed === null) {
              new Notice("Content token limit must be a positive integer");
              text.setValue(this.plugin.settings.contentTokenLimit.toString());
              return;
            }
            this.plugin.settings.contentTokenLimit = parsed;
            await this.plugin.saveSettings();
          }),
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

    new Setting(containerEl)
      .setName("Tags Field Name")
      .setDesc("Frontmatter field name for tags")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.tagsFieldName)
          .onChange(async (value) => {
            this.plugin.settings.tagsFieldName = value || "tags";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Tags Prompt")
      .setDesc(
        `Instructions for tag generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.tagsPrompt)
          .onChange(async (value) => {
            if (value.length > PROMPT_MAX_LENGTH) {
              new Notice(
                `Tags prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
              );
              text.setValue(this.plugin.settings.tagsPrompt);
              return;
            }
            this.plugin.settings.tagsPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.setAttr("rows", "3");
      });

    // Description Settings
    new Setting(containerEl).setName("Description Settings").setHeading();

    new Setting(containerEl)
      .setName("Description Field Name")
      .setDesc("Frontmatter field name for description")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.descriptionFieldName)
          .onChange(async (value) => {
            this.plugin.settings.descriptionFieldName = value || "description";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Description Prompt")
      .setDesc(
        `Instructions for description generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.descriptionPrompt)
          .onChange(async (value) => {
            if (value.length > PROMPT_MAX_LENGTH) {
              new Notice(
                `Description prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
              );
              text.setValue(this.plugin.settings.descriptionPrompt);
              return;
            }
            this.plugin.settings.descriptionPrompt = value;
            await this.plugin.saveSettings();
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
      .addText((text) =>
        text
          .setValue(this.plugin.settings.titleFieldName)
          .onChange(async (value) => {
            this.plugin.settings.titleFieldName = value || "title";
            await this.plugin.saveSettings();
          }),
      );

    const titlePromptSetting = new Setting(containerEl)
      .setName("Title Prompt")
      .setDesc(
        `Instructions for title generation (max ${PROMPT_MAX_LENGTH} chars)`,
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.titlePrompt)
          .onChange(async (value) => {
            if (value.length > PROMPT_MAX_LENGTH) {
              new Notice(
                `Title prompt cannot exceed ${PROMPT_MAX_LENGTH} characters`,
              );
              text.setValue(this.plugin.settings.titlePrompt);
              return;
            }
            this.plugin.settings.titlePrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.setAttr("rows", "3");
      });

    titleFieldNameSetting.setDisabled(!this.plugin.settings.enableTitle);
    titlePromptSetting.setDisabled(!this.plugin.settings.enableTitle);
  }
}
