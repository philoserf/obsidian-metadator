import { Notice, Plugin } from "obsidian";
import { CliRuns, readResult, startGenerate } from "./cli";
import { clearInFlight } from "./inFlight";
import {
  DEFAULT_SETTINGS,
  type MetadataConfig,
  type MetadataToolSettings,
} from "./settings";
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
  private settingTab!: MetadataToolSettingTab;
  // CLI runs started and not yet read back, for `metadator:result` (#323).
  private readonly cliRuns = new CliRuns();

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
    // on the active note and prints nothing. One file per call. The CLI stops
    // waiting long before a generation finishes, so this starts the run and
    // `metadator:result` reads it back (#323).
    this.registerCliHandler(
      "metadator:generate",
      "Start generating metadata for one note; prints a run id, or the result when no API call is needed",
      {
        path: {
          value: "<path>",
          description: "Vault path of the note",
          required: true,
        },
        "dry-run": {
          description:
            "Report what would be written without writing it (still billed)",
        },
      },
      (params) =>
        startGenerate(
          this.app,
          this.config(),
          params,
          this.cliRuns,
          this.runController.signal,
        ),
    );

    this.registerCliHandler(
      "metadator:result",
      "Print a started run's result as JSON, or that it is still running",
      {
        id: {
          value: "<id>",
          description: "Run id printed by metadator:generate",
          required: true,
        },
      },
      (params) => readResult(params, this.cliRuns),
    );

    this.settingTab = new MetadataToolSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  // loadSettings never writes, so a synced change is adopted without a write
  // and cannot bounce data.json between devices. A file from a newer
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
