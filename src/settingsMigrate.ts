import {
  areFieldNamesDistinct,
  CHOICE_VALUE_MAX_LENGTH,
  CHOICE_VALUES_MAX,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  enabledFields,
  FIELD_NAME_KEY,
  isModelId,
  MAX_CONTENT_TOKEN_LIMIT,
  METADATA_FIELDS,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
  TRUNCATE_METHOD_LABELS,
  WRITE_POLICY_LABELS,
  type WritePolicy,
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

function isWritePolicy(value: string): value is WritePolicy {
  return Object.hasOwn(WRITE_POLICY_LABELS, value);
}

function readPolicy(value: unknown, fallback: WritePolicy): WritePolicy {
  const candidate = readString(value, fallback);
  return isWritePolicy(candidate) ? candidate : fallback;
}

// A choice list is trimmed, de-duplicated and bounded. An empty string is not
// a value: it is the tool's "none" answer. A list left with nothing — or
// anything but an array of strings — falls back whole to the default, since a
// choice field with no values could never write.
function readChoiceValues(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return [...fallback];
  }
  const values = [
    ...new Set(
      (value as string[]).map((v) => v.trim()).filter((v) => v !== ""),
    ),
  ];
  return values.length === 0 ||
    values.length > CHOICE_VALUES_MAX ||
    values.some((v) => v.length > CHOICE_VALUE_MAX_LENGTH)
    ? [...fallback]
    : values;
}

// Schema migrations, keyed by the version they produce. To add migration N,
// add an entry [N, fn] and bump CURRENT_SCHEMA_VERSION in settings.ts. Each
// migration mutates the raw bag in place; trust-boundary normalization runs
// afterward in migrateSettings.
const MIGRATIONS: ReadonlyMap<number, (s: Record<string, unknown>) => void> =
  new Map<number, (s: Record<string, unknown>) => void>([
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
        // The fields are kept differently, and no single enum value could
        // express "refresh the description" without also meaning "rewrite
        // every title".
        //
        // preserve_existing mapped to leaving every populated field alone, so
        // every policy becomes `preserve`; always_regenerate mapped to
        // overwriting, so every policy becomes `regenerate`. Nothing about
        // that user's runs changes. (This step also set a tags policy; tag
        // generation is gone since v6, so it no longer does.)
        //
        // An absent updateMethod means the bag predates the setting or never
        // set it, in which case preserve_existing was its effective default.
        const regenerate = s.updateMethod === "always_regenerate";
        s.descriptionPolicy = regenerate ? "regenerate" : "preserve";
        s.titlePolicy = regenerate ? "regenerate" : "preserve";
        delete s.updateMethod;
      },
    ],
    [
      4,
      () => {
        // 3 → 4: the API key moves from data.json to Obsidian's keychain
        // (#281). Nothing to rewrite here: normalization drops a plaintext
        // anthropicApiKey. The bump is what matters — a v3 build syncing this
        // file goes read-only rather than saving it back without the secret's
        // ID. The one-time move of the plaintext key into the keychain was
        // removed on 2026-10-28, once no synced data.json carried one.
      },
    ],
    [
      5,
      (s) => {
        // 4 → 5: the other generated fields get on/off toggles beside
        // enableTitle (#305). They default on, so an upgrade changes nothing.
        // The bump is the point, as with v4: a v4 build on another device
        // (say, the iPad a note is published from) syncing this file would
        // otherwise save it back without the new keys, silently turning a
        // switched-off field back on. Seeing a future version, that build goes
        // read-only instead. (This step also defaulted a tags toggle; tag
        // generation is gone since v6, so it no longer does.)
        if (s.enableDescription === undefined) s.enableDescription = true;
      },
    ],
    [
      6,
      (s) => {
        // 5 → 6: tag generation is removed (#310). Its four settings are
        // deleted here rather than left for normalization to drop, so the
        // removal is stated once, as a migration. Notes keep whatever tags
        // they hold — the plugin no longer reads or writes the field. The bump
        // matters as with v4 and v5: a v5 build syncing this file would
        // otherwise save the tag keys back with tag generation switched on;
        // seeing a future version, it goes read-only instead.
        delete s.tagsFieldName;
        delete s.enableTags;
        delete s.tagsPolicy;
        delete s.tagsPrompt;
      },
    ],
    [
      7,
      () => {
        // 6 → 7: the eyebrow choice field (#308). Nothing to rewrite —
        // normalization fills its five keys from the defaults, with the field
        // off. The bump is the point, as with v4 to v6: a v6 build syncing this
        // file would otherwise save it back without the eyebrow keys,
        // silently switching the field off on every device; seeing a future
        // version, it goes read-only instead.
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

  const normalized: MetadataToolSettings = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    anthropicApiKeySecret: readString(
      migrated.anthropicApiKeySecret,
      DEFAULT_SETTINGS.anthropicApiKeySecret,
    ),
    // Accept any well-formed model id, not just the ones in the dropdown, so
    // a model released after this build survives a reload.
    anthropicModel: isModelId(anthropicModel)
      ? anthropicModel
      : DEFAULT_SETTINGS.anthropicModel,
    // Field names are trimmed here, the one place both a load and a settings
    // edit pass through, so " title " cannot become a malformed YAML key (#186).
    descriptionFieldName: readString(
      migrated.descriptionFieldName,
      DEFAULT_SETTINGS.descriptionFieldName,
      { nonEmpty: true },
    ).trim(),
    titleFieldName: readString(
      migrated.titleFieldName,
      DEFAULT_SETTINGS.titleFieldName,
      { nonEmpty: true },
    ).trim(),
    eyebrowFieldName: readString(
      migrated.eyebrowFieldName,
      DEFAULT_SETTINGS.eyebrowFieldName,
      { nonEmpty: true },
    ).trim(),
    enableDescription: readBoolean(
      migrated.enableDescription,
      DEFAULT_SETTINGS.enableDescription,
    ),
    enableTitle: readBoolean(
      migrated.enableTitle,
      DEFAULT_SETTINGS.enableTitle,
    ),
    enableEyebrow: readBoolean(
      migrated.enableEyebrow,
      DEFAULT_SETTINGS.enableEyebrow,
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
    truncateMethod: isTruncateMethod(truncateMethodCandidate)
      ? truncateMethodCandidate
      : DEFAULT_SETTINGS.truncateMethod,
    descriptionPolicy: readPolicy(
      migrated.descriptionPolicy,
      DEFAULT_SETTINGS.descriptionPolicy,
    ),
    titlePolicy: readPolicy(migrated.titlePolicy, DEFAULT_SETTINGS.titlePolicy),
    eyebrowPolicy: readPolicy(
      migrated.eyebrowPolicy,
      DEFAULT_SETTINGS.eyebrowPolicy,
    ),
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
    eyebrowPrompt: readString(
      migrated.eyebrowPrompt,
      DEFAULT_SETTINGS.eyebrowPrompt,
      { nonEmpty: true, maxLength: PROMPT_MAX_LENGTH },
    ),
    eyebrowValues: readChoiceValues(
      migrated.eyebrowValues,
      DEFAULT_SETTINGS.eyebrowValues,
    ),
  };

  // All reset together. It is the only rule that is order-independent and
  // cannot itself produce a new collision, since the defaults are distinct by
  // construction.
  //
  // Both branches warn. This path used to be silent, unlike the forward-schema
  // path above — so a user whose field names were reset saw their notes acquire
  // `tags` and `description` keys alongside the `keywords` and `summary` they
  // had been using, with nothing anywhere saying why (#248).
  if (!areFieldNamesDistinct(normalized)) {
    console.warn(
      "[Metadator] Frontmatter field names collide; resetting them all to their defaults.",
    );
    for (const field of METADATA_FIELDS) {
      const key = FIELD_NAME_KEY[field];
      normalized[key] = DEFAULT_SETTINGS[key];
    }
  } else {
    // The in-use name is fine and only an inert one collides. Resetting both
    // here would destroy valid settings to fix a value nothing reads —
    // the bug this replaces. Normalizing it anyway, rather than leaving it,
    // so that turning that field back on later does not then trip the branch
    // above and take the other down with it. Collisions are judged against
    // the names as loaded, so two disabled fields sharing a name both reset.
    const enabled = enabledFields(normalized);
    const loadedNames = METADATA_FIELDS.map(
      (f) => normalized[FIELD_NAME_KEY[f]],
    );
    for (const field of METADATA_FIELDS) {
      if (enabled.has(field)) continue;
      const key = FIELD_NAME_KEY[field];
      const name = normalized[key];
      if (loadedNames.filter((n) => n === name).length < 2) continue;
      console.warn(
        `[Metadator] ${key} "${name}" collides with another field name; resetting it to "${DEFAULT_SETTINGS[key]}". ${field[0]?.toUpperCase()}${field.slice(1)} generation is off, so the other name is unaffected.`,
      );
      normalized[key] = DEFAULT_SETTINGS[key];
    }
  }

  return {
    kind: "ok",
    settings: normalized,
  };
}
