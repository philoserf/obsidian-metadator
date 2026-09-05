import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  isModelId,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
  VALID_TRUNCATE_METHOD_OPTIONS,
  VALID_UPDATE_METHOD_OPTIONS,
} from "./settings";

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
    [
      2,
      (s) => {
        // 1 → 2: rename retired model identifiers.
        if (s.anthropicModel === "claude-sonnet-4-6") {
          s.anthropicModel = "claude-sonnet-5";
        }
        if (s.anthropicModel === "claude-opus-4-6") {
          s.anthropicModel = "claude-opus-5";
        }
        if (s.anthropicModel === "claude-haiku-4-5-20251001") {
          s.anthropicModel = "claude-haiku-4-5";
        }
      },
    ],
  ]);

function readSchemaVersion(raw: Record<string, unknown>): number {
  return typeof raw.schemaVersion === "number" &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion >= 0
    ? raw.schemaVersion
    : 0;
}

export function applyMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  migrations: ReadonlyMap<
    number,
    (s: Record<string, unknown>) => void
  > = MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...raw };
  for (let v = fromVersion + 1; v <= targetVersion; v++) {
    const fn = migrations.get(v);
    if (!fn) {
      // A bumped CURRENT_SCHEMA_VERSION without a matching MIGRATIONS entry
      // would silently stamp the new version onto un-transformed data. Fail
      // loudly instead so the bug is caught at plugin-load time.
      throw new Error(
        `[Metadator] missing migration for schema version ${v}; bump CURRENT_SCHEMA_VERSION only after adding MIGRATIONS[${v}].`,
      );
    }
    fn(migrated);
  }
  migrated.schemaVersion = targetVersion;
  return migrated;
}

export type MigrationResult =
  | { kind: "ok"; settings: MetadataToolSettings }
  | { kind: "missing" }
  | { kind: "future"; loadedSchemaVersion: number };

export function migrateSettings(loaded: unknown | null): MigrationResult {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return { kind: "missing" };
  }

  const raw = loaded as Record<string, unknown>;
  const fromVersion = readSchemaVersion(raw);

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    console.warn(
      `[Metadator] data.json schemaVersion=${fromVersion} is newer than this plugin (${CURRENT_SCHEMA_VERSION}). Falling back to defaults to avoid corrupting your data.`,
    );
    return { kind: "future", loadedSchemaVersion: fromVersion };
  }

  const migrated = applyMigrations(raw, fromVersion);

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
    // Accept any well-formed model id, not just the ones in the dropdown, so
    // a model released after this build survives a reload.
    anthropicModel: isModelId(anthropicModel)
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

  return { kind: "ok", settings: normalized };
}
