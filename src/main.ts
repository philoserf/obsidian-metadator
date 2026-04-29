import { Notice, Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { migrateSettings } from "./settingsMigrate";
import { MetadataToolSettingTab } from "./settingsTab";

export default class MetadataToolPlugin extends Plugin {
  settings: MetadataToolSettings = DEFAULT_SETTINGS;
  private runController: AbortController = new AbortController();
  // Set when data.json was written by a newer plugin version. While set,
  // saveSettings() refuses to write so we don't clobber forward-version
  // data with our defaults. Cleared by a successful (in-version) load.
  private futureSchemaBlocked = false;

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
    const result = migrateSettings(await this.loadData());
    if (result.kind === "ok") {
      this.settings = { ...result.settings };
      this.futureSchemaBlocked = false;
    } else if (result.kind === "future") {
      this.settings = { ...DEFAULT_SETTINGS };
      this.futureSchemaBlocked = true;
      new Notice(
        `Metadator settings were written by a newer plugin version (schema v${result.loadedSchemaVersion}). Settings won't be saved until you upgrade the plugin to avoid corrupting your data.`,
        12000,
      );
    } else {
      this.settings = { ...DEFAULT_SETTINGS };
      this.futureSchemaBlocked = false;
    }
  }

  async saveSettings(): Promise<void> {
    if (this.futureSchemaBlocked) {
      new Notice(
        "Refusing to save: settings file is from a newer plugin version. Upgrade the plugin or delete data.json to proceed.",
        8000,
      );
      return;
    }
    await this.saveData(this.settings);
  }
}
