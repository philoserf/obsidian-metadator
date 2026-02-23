import { Plugin } from "obsidian";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { MetadataToolSettingTab } from "./settingsTab";

export default class MetadataToolPlugin extends Plugin {
  settings: MetadataToolSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "generate-metadata",
      name: "Generate metadata for current note",
      callback: async () => {
        await generateMetadata(this.app, this.settings);
      },
    });

    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
  }

  onunload(): void {}

  async loadSettings(): Promise<void> {
    const loadedSettings = await this.loadData();

    // Migrate old settings values
    if (
      loadedSettings?.updateMethod === "force" ||
      loadedSettings?.updateMethod === "update_all"
    ) {
      loadedSettings.updateMethod = "always_regenerate";
    } else if (
      loadedSettings?.updateMethod === "no-llm" ||
      loadedSettings?.updateMethod === "empty_only"
    ) {
      loadedSettings.updateMethod = "preserve_existing";
    }

    // Migrate default model to Claude 4.6
    if (loadedSettings?.anthropicModel === "claude-sonnet-4-5-20250929") {
      loadedSettings.anthropicModel = "claude-sonnet-4-6";
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
