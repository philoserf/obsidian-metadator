import { Notice, Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { clearInFlight } from "./inFlight";
import { logError } from "./logger";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { migrateSettings } from "./settingsMigrate";
import { decideLoad, decideSave } from "./settingsStore";
import { MetadataToolSettingTab } from "./settingsTab";
import { generateMetadata } from "./singleNote";

export default class MetadataToolPlugin extends Plugin {
  override settings: MetadataToolSettings = DEFAULT_SETTINGS;
  // Assigned first thing in onload(), which Obsidian always calls before any
  // command, menu item, or onunload() can run. No field initializer here: it
  // would construct a controller that onload() discards on the next line.
  private runController!: AbortController;
  // Set when data.json was written by a newer plugin version. While set,
  // saveSettings() refuses to write so we don't clobber forward-version data
  // with our defaults. The decision itself lives in settingsStore.ts, where it
  // can be tested without a Plugin; this field is only where the answer is
  // kept between the two calls.
  private writesBlocked = false;

  override async onload(): Promise<void> {
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
              // Obsidian does not await this handler, so a rejection here would
              // be an unhandled promise: no notice, no log, and a menu item that
              // silently does nothing. The single-note command reaches the same
              // guarantee through generateMetadata's own try/catch.
              try {
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
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                new Notice(
                  `Bulk metadata generation failed: ${errorMessage}`,
                  8000,
                );
                logError({
                  event: "generation_failed",
                  file: fileOrFolder.path,
                  errorMessage,
                });
              }
            }),
        );
      }),
    );

    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
  }

  override onunload(): void {
    this.runController.abort("plugin_unloaded");
    clearInFlight();
  }

  async loadSettings(): Promise<void> {
    const decision = decideLoad(migrateSettings(await this.loadData()));
    this.settings = decision.settings;
    this.writesBlocked = decision.writesBlocked;
    if (decision.notice) new Notice(decision.notice, 12000);
  }

  async saveSettings(): Promise<void> {
    const decision = decideSave(this.writesBlocked);
    if (decision.kind === "refuse") {
      new Notice(decision.notice, 8000);
      return;
    }
    await this.saveData(this.settings);
  }
}
