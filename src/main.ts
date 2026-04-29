import { Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateMetadata } from "./metadata";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
  VALID_MODEL_OPTIONS,
  VALID_TRUNCATE_METHOD_OPTIONS,
  VALID_UPDATE_METHOD_OPTIONS,
} from "./settings";
import { MetadataToolSettingTab } from "./settingsTab";

const VALID_MODELS = new Set<string>(VALID_MODEL_OPTIONS);

function readString(
  value: unknown,
  fallback: string,
  {
    nonEmpty = false,
    maxLength,
  }: { nonEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") return fallback;
  if (nonEmpty && value.trim() === "") return fallback;
  if (maxLength !== undefined && value.length > maxLength) return fallback;
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

function isTruncateMethod(
  value: string,
): value is MetadataToolSettings["truncateMethod"] {
  return (
    value === VALID_TRUNCATE_METHOD_OPTIONS[0] ||
    value === VALID_TRUNCATE_METHOD_OPTIONS[1] ||
    value === VALID_TRUNCATE_METHOD_OPTIONS[2]
  );
}

function isUpdateMethod(
  value: string,
): value is MetadataToolSettings["updateMethod"] {
  return (
    value === VALID_UPDATE_METHOD_OPTIONS[0] ||
    value === VALID_UPDATE_METHOD_OPTIONS[1]
  );
}

// Schema migrations, keyed by the version they produce. To add migration N,
// add an entry [N, fn] and bump CURRENT_SCHEMA_VERSION in settings.ts. Each
// migration mutates the raw bag in place; trust-boundary normalization runs
// afterward in migrateSettings.
const MIGRATIONS: ReadonlyMap<number, (s: Record<string, unknown>) => void> =
  new Map([
    [
      1,
      (s) => {
        // 0 → 1: rename retired model identifiers.
        if (s.anthropicModel === "claude-sonnet-4-5-20250929") {
          s.anthropicModel = "claude-sonnet-4-6";
        }
        if (s.anthropicModel === "claude-opus-4-5-20251101") {
          s.anthropicModel = "claude-opus-4-6";
        }
      },
    ],
  ]);

function applyMigrations(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const fromVersion =
    typeof raw.schemaVersion === "number" &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion >= 0
      ? raw.schemaVersion
      : 0;

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    console.warn(
      `[Metadator] data.json schemaVersion=${fromVersion} is newer than this plugin (${CURRENT_SCHEMA_VERSION}). Falling back to defaults to avoid corrupting your data.`,
    );
    return null;
  }

  const migrated: Record<string, unknown> = { ...raw };
  for (let v = fromVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    MIGRATIONS.get(v)?.(migrated);
  }
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return migrated;
}

export function migrateSettings(
  loaded: unknown | null,
): MetadataToolSettings | null {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return null;
  }

  const migrated = applyMigrations(loaded as Record<string, unknown>);
  if (migrated === null) return null;

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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
    maxBulkFiles: readPositiveInt(
      migrated.maxBulkFiles,
      DEFAULT_SETTINGS.maxBulkFiles,
    ),
    truncateMethod: isTruncateMethod(truncateMethodCandidate)
      ? truncateMethodCandidate
      : DEFAULT_SETTINGS.truncateMethod,
    updateMethod: isUpdateMethod(updateMethodCandidate)
      ? updateMethodCandidate
      : DEFAULT_SETTINGS.updateMethod,
    tagsPrompt: readString(migrated.tagsPrompt, DEFAULT_SETTINGS.tagsPrompt, {
      nonEmpty: true,
      maxLength: PROMPT_MAX_LENGTH,
    }),
    descriptionPrompt: readString(
      migrated.descriptionPrompt,
      DEFAULT_SETTINGS.descriptionPrompt,
      { nonEmpty: true, maxLength: PROMPT_MAX_LENGTH },
    ),
    titlePrompt: readString(
      migrated.titlePrompt,
      DEFAULT_SETTINGS.titlePrompt,
      {
        nonEmpty: true,
        maxLength: PROMPT_MAX_LENGTH,
      },
    ),
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
