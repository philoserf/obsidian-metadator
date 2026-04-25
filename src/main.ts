import { Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { MetadataToolSettingTab } from "./settingsTab";

export function migrateSettings(
  loaded: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!loaded) return loaded;

  if (loaded.anthropicModel === "claude-sonnet-4-5-20250929") {
    loaded.anthropicModel = "claude-sonnet-4-6";
  }

  if (loaded.anthropicModel === "claude-opus-4-5-20251101") {
    loaded.anthropicModel = "claude-opus-4-6";
  }

  return loaded;
}

export default class MetadataToolPlugin extends Plugin {
  settings: MetadataToolSettings = DEFAULT_SETTINGS;
  private runController: AbortController = new AbortController();

  async onload(): Promise<void> {
    this.runController = new AbortController();
    await this.loadSettings();

    this.addCommand({
      id: "generate-metadata",
      name: "Generate metadata for current note",
      callback: async () => {
        await generateMetadata(this.app, this.settings, {
          signal: this.runController.signal,
        });
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, fileOrFolder) => {
        if (!(fileOrFolder instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("Generate metadata (recursive)")
            .setIcon("tags")
            .onClick(async () => {
              await runBulkForFolder(
                this.app,
                fileOrFolder,
                {
                  ...this.settings,
                },
                {
                  signal: this.runController.signal,
                },
              );
            }),
        );
      }),
    );

    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
  }

  onunload(): void {
    this.runController.abort("plugin_unloaded");
  }

  async loadSettings(): Promise<void> {
    const loadedSettings = migrateSettings(await this.loadData());
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
