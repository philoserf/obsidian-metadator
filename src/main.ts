import { Notice, Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateForPath } from "./cli";
import { clearInFlight } from "./inFlight";
import { logError } from "./logger";
import {
  DEFAULT_SETTINGS,
  type MetadataConfig,
  type MetadataToolSettings,
} from "./settings";
import { migrateSettings } from "./settingsMigrate";
import { decideLoad, decideSave, migrateApiKey } from "./settingsStore";
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
  private settingTab!: MetadataToolSettingTab;

  override async onload(): Promise<void> {
    this.runController = new AbortController();
    await this.loadSettings();

    this.addCommand({
      id: "generate-metadata",
      name: "Generate metadata for current note",
      callback: async () => {
        await generateMetadata(this.app, this.config(), {
          signal: this.runController.signal,
        });
      },
    });

    // For automation driving Obsidian through its CLI, whose `command id=` acts
    // on the active note and prints nothing. One file per call: a bulk run's
    // cost cap and confirmation step stay in the folder menu.
    this.registerCliHandler(
      "metadator:generate",
      "Generate metadata for one note and print the result as JSON",
      {
        path: {
          value: "<path>",
          description: "Vault path of the note",
          required: true,
        },
      },
      (params) =>
        generateForPath(
          this.app,
          this.config(),
          params,
          this.runController.signal,
        ),
    );

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
                await runBulkForFolder(this.app, fileOrFolder, this.config(), {
                  signal: this.runController.signal,
                });
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

    this.settingTab = new MetadataToolSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  // loadSettings writes only when the synced file carries a legacy plaintext
  // key to move into the keychain, so an ordinary change is adopted without a
  // write and cannot bounce data.json between devices. A file from a newer
  // version is adopted as a block, exactly as at load.
  override async onExternalSettingsChange(): Promise<void> {
    await this.settingTab.reloadSettings(() => this.loadSettings());
  }

  override onunload(): void {
    this.runController.abort("plugin_unloaded");
    clearInFlight();
  }

  // The settings with the key read out of secret storage. Read when a command
  // runs, never cached: the key can change in Settings → Keychain without
  // these settings changing at all. Unset or missing resolves to "", which
  // both entry points already report as a missing key.
  config(): MetadataConfig {
    const id = this.settings.anthropicApiKeySecret;
    return {
      ...this.settings,
      anthropicApiKey: (id && this.app.secretStorage.getSecret(id)) || "",
    };
  }

  async loadSettings(): Promise<void> {
    const decision = decideLoad(migrateSettings(await this.loadData()));
    this.settings = decision.settings;
    this.writesBlocked = decision.writesBlocked;
    if (decision.notice) new Notice(decision.notice, 12000);
    if (
      migrateApiKey(
        this.settings,
        decision.legacyApiKey,
        this.app.secretStorage,
      )
    ) {
      await this.saveSettings();
    }
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
