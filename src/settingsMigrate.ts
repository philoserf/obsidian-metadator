import {
  API_KEY_MAX_LENGTH,
  areFieldNamesDistinct,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  isModelId,
  MAX_BULK_FILES,
  MAX_CONTENT_TOKEN_LIMIT,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
  SCALAR_POLICY_LABELS,
  type ScalarPolicy,
  TAGS_POLICY_LABELS,
  TRUNCATE_METHOD_LABELS,
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

function readPositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= max
    ? value
    : fallback;
}

// Membership in the label record is the definition of a valid option, so a
// new option is added in one place. Object.hasOwn, not `in`: `in` walks the
// prototype chain and would accept "toString" as a truncate method.
function isTruncateMethod(
  value: string,
): value is MetadataToolSettings["truncateMethod"] {
  return Object.hasOwn(TRUNCATE_METHOD_LABELS, value);
}

function isTagsPolicy(
  value: string,
): value is MetadataToolSettings["tagsPolicy"] {
  return Object.hasOwn(TAGS_POLICY_LABELS, value);
}

function isScalarPolicy(value: string): value is ScalarPolicy {
  return Object.hasOwn(SCALAR_POLICY_LABELS, value);
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
    [
      3,
      (s) => {
        // 2 → 3: one global updateMethod becomes a policy per field (#252).
        // The three fields are different kinds of value, and no single enum
        // value could express "clean up tags" without also meaning "rewrite
        // every title".
        //
        // preserve_existing mapped to leaving every populated field alone, so
        // all three become `preserve` and nothing about that user's runs
        // changes.
        //
        // always_regenerate mapped to: tags appended (never replaced —
        // the #230 bug), description and title overwritten. Its tags become
        // `reconcile` rather than `merge`, which is a deliberate behavior
        // change on upgrade: append could never remove a tag, so the sprawl it
        // produced was unfixable from the settings tab. `merge` remains
        // available for anyone who wants the old behavior back.
        //
        // An absent updateMethod means the bag predates the setting or never
        // set it, in which case preserve_existing was its effective default.
        const regenerate = s.updateMethod === "always_regenerate";
        s.tagsPolicy = regenerate ? "reconcile" : "preserve";
        s.descriptionPolicy = regenerate ? "overwrite" : "preserve";
        s.titlePolicy = regenerate ? "overwrite" : "preserve";
        delete s.updateMethod;
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
  const tagsPolicyCandidate = readString(
    migrated.tagsPolicy,
    DEFAULT_SETTINGS.tagsPolicy,
  );
  const descriptionPolicyCandidate = readString(
    migrated.descriptionPolicy,
    DEFAULT_SETTINGS.descriptionPolicy,
  );
  const titlePolicyCandidate = readString(
    migrated.titlePolicy,
    DEFAULT_SETTINGS.titlePolicy,
  );

  const normalized: MetadataToolSettings = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    anthropicApiKey: readString(
      migrated.anthropicApiKey,
      DEFAULT_SETTINGS.anthropicApiKey,
      { maxLength: API_KEY_MAX_LENGTH },
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
      MAX_CONTENT_TOKEN_LIMIT,
    ),
    maxBulkFiles: readPositiveInt(
      migrated.maxBulkFiles,
      DEFAULT_SETTINGS.maxBulkFiles,
      MAX_BULK_FILES,
    ),
    truncateMethod: isTruncateMethod(truncateMethodCandidate)
      ? truncateMethodCandidate
      : DEFAULT_SETTINGS.truncateMethod,
    tagsPolicy: isTagsPolicy(tagsPolicyCandidate)
      ? tagsPolicyCandidate
      : DEFAULT_SETTINGS.tagsPolicy,
    descriptionPolicy: isScalarPolicy(descriptionPolicyCandidate)
      ? descriptionPolicyCandidate
      : DEFAULT_SETTINGS.descriptionPolicy,
    titlePolicy: isScalarPolicy(titlePolicyCandidate)
      ? titlePolicyCandidate
      : DEFAULT_SETTINGS.titlePolicy,
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

  // All three reset together, not just the colliding pair. It is the only rule
  // that is order-independent and cannot itself produce a new collision, since
  // the defaults are distinct by construction.
  if (!areFieldNamesDistinct(normalized)) {
    normalized.tagsFieldName = DEFAULT_SETTINGS.tagsFieldName;
    normalized.descriptionFieldName = DEFAULT_SETTINGS.descriptionFieldName;
    normalized.titleFieldName = DEFAULT_SETTINGS.titleFieldName;
  }

  return { kind: "ok", settings: normalized };
}
