import { type App, PluginSettingTab, Setting } from "obsidian";
import type MetadataToolPlugin from "./main";

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

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Claude model to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5")
          .addOption("claude-opus-4-5-20251101", "Claude Opus 4.5")
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
          .setValue(this.plugin.settings.anthropicModel)
          .onChange(async (value) => {
            this.plugin.settings.anthropicModel = value;
            await this.plugin.saveSettings();
          }),
      );

    // Update Settings
    new Setting(containerEl).setName("Update Settings").setHeading();

    new Setting(containerEl)
      .setName("Update Method")
      .setDesc(
        "Always Regenerate: re-run Claude on every command; Preserve Existing: only generate empty fields",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("always_regenerate", "Always Regenerate")
          .addOption("preserve_existing", "Preserve Existing")
          .setValue(this.plugin.settings.updateMethod)
          .onChange(async (value) => {
            this.plugin.settings.updateMethod = value as
              | "always_regenerate"
              | "preserve_existing";
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
            maxTokensSetting.setDisabled(!value);
            truncateMethodSetting.setDisabled(!value);
          }),
      );

    const maxTokensSetting = new Setting(containerEl)
      .setName("Max Tokens")
      .setDesc("Maximum content length in tokens")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.maxTokens.toString())
          .onChange(async (value) => {
            this.plugin.settings.maxTokens = parseInt(value, 10) || 1000;
            await this.plugin.saveSettings();
          }),
      );

    const truncateMethodSetting = new Setting(containerEl)
      .setName("Truncate Method")
      .setDesc("How to truncate long content")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("head_only", "Beginning Only")
          .addOption("head_tail", "Beginning + End")
          .addOption("heading", "Headings + Summaries")
          .setValue(this.plugin.settings.truncateMethod)
          .onChange(async (value) => {
            this.plugin.settings.truncateMethod = value as
              | "head_only"
              | "head_tail"
              | "heading";
            await this.plugin.saveSettings();
          }),
      );

    maxTokensSetting.setDisabled(!this.plugin.settings.truncateContent);
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
      .setDesc("Instructions for tag generation")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.tagsPrompt)
          .onChange(async (value) => {
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
      .setDesc("Instructions for description generation")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.descriptionPrompt)
          .onChange(async (value) => {
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
            titlePromptSetting.setDisabled(!value);
          }),
      );

    new Setting(containerEl)
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
      .setDesc("Instructions for title generation")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.titlePrompt)
          .onChange(async (value) => {
            this.plugin.settings.titlePrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.setAttr("rows", "3");
      });

    titlePromptSetting.setDisabled(!this.plugin.settings.enableTitle);
  }
}
