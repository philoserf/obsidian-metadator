import { Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { MetadataToolSettingTab } from "./settingsTab";

const VALID_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
]);
const VALID_TRUNCATE_METHODS = new Set(["head_only", "head_tail", "heading"]);
const VALID_UPDATE_METHODS = new Set([
  "always_regenerate",
  "preserve_existing",
]);

function readString(
  value: unknown,
  fallback: string,
  { nonEmpty = false }: { nonEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") return fallback;
  if (nonEmpty && value.trim() === "") return fallback;
  return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function migrateSettings(
  loaded: Record<string, unknown> | null,
): MetadataToolSettings | null {
  if (!loaded) return loaded;

  const migrated = { ...loaded };

  if (migrated.anthropicModel === "claude-sonnet-4-5-20250929") {
    migrated.anthropicModel = "claude-sonnet-4-6";
  }

  if (migrated.anthropicModel === "claude-opus-4-5-20251101") {
    migrated.anthropicModel = "claude-opus-4-6";
  }

  const anthropicModel = readString(
    migrated.anthropicModel,
    DEFAULT_SETTINGS.anthropicModel,
  );
  const truncateMethodCandidate = readString(
    migrated.truncateMethod,
    DEFAULT_SETTINGS.truncateMethod,
  );
  const updateMethodCandidate = readString(
    migrated.updateMethod,
    DEFAULT_SETTINGS.updateMethod,
  );

  const normalized: MetadataToolSettings = {
    anthropicApiKey: readString(
      migrated.anthropicApiKey,
      DEFAULT_SETTINGS.anthropicApiKey,
    ),
    anthropicModel: VALID_MODELS.has(anthropicModel)
      ? anthropicModel
      : DEFAULT_SETTINGS.anthropicModel,
    tagsFieldName: readString(
      migrated.tagsFieldName,
      DEFAULT_SETTINGS.tagsFieldName,
      { nonEmpty: true },
    ),
    descriptionFieldName: readString(
      migrated.descriptionFieldName,
      DEFAULT_SETTINGS.descriptionFieldName,
      { nonEmpty: true },
    ),
    titleFieldName: readString(
      migrated.titleFieldName,
      DEFAULT_SETTINGS.titleFieldName,
      { nonEmpty: true },
    ),
    enableTitle: readBoolean(
      migrated.enableTitle,
      DEFAULT_SETTINGS.enableTitle,
    ),
    debugLogging: readBoolean(
      migrated.debugLogging,
      DEFAULT_SETTINGS.debugLogging,
    ),
    truncateContent: readBoolean(
      migrated.truncateContent,
      DEFAULT_SETTINGS.truncateContent,
    ),
    contentTokenLimit: readPositiveInt(
      migrated.contentTokenLimit,
      DEFAULT_SETTINGS.contentTokenLimit,
    ),
    truncateMethod: VALID_TRUNCATE_METHODS.has(truncateMethodCandidate)
      ? (truncateMethodCandidate as MetadataToolSettings["truncateMethod"])
      : DEFAULT_SETTINGS.truncateMethod,
    updateMethod: VALID_UPDATE_METHODS.has(updateMethodCandidate)
      ? (updateMethodCandidate as MetadataToolSettings["updateMethod"])
      : DEFAULT_SETTINGS.updateMethod,
    tagsPrompt: readString(migrated.tagsPrompt, DEFAULT_SETTINGS.tagsPrompt),
    descriptionPrompt: readString(
      migrated.descriptionPrompt,
      DEFAULT_SETTINGS.descriptionPrompt,
    ),
    titlePrompt: readString(migrated.titlePrompt, DEFAULT_SETTINGS.titlePrompt),
  };

  return normalized;
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
    this.settings = { ...(loadedSettings ?? DEFAULT_SETTINGS) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
