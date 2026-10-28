import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  MAX_CONTENT_TOKEN_LIMIT,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
} from "./settings";
import { applyMigrations, migrateSettings } from "./settingsMigrate";

function ok(loaded: unknown | null): MetadataToolSettings {
  const result = migrateSettings(loaded);
  if (result.kind !== "ok") {
    throw new Error(`expected kind=ok, got kind=${result.kind}`);
  }
  return result.settings;
}

describe("migrateSettings", () => {
  test("returns kind:missing for null input", () => {
    expect(migrateSettings(null)).toEqual({ kind: "missing" });
  });

  test("returns kind:missing for non-object input", () => {
    expect(migrateSettings("not an object")).toEqual({ kind: "missing" });
    expect(migrateSettings(42)).toEqual({ kind: "missing" });
    expect(migrateSettings([1, 2, 3])).toEqual({ kind: "missing" });
  });

  test("migrates old sonnet model through to claude-sonnet-5", () => {
    expect(
      ok({ anthropicModel: "claude-sonnet-4-5-20250929" }).anthropicModel,
    ).toBe("claude-sonnet-5");
  });

  test("migrates old opus model through to claude-opus-5", () => {
    expect(
      ok({ anthropicModel: "claude-opus-4-5-20251101" }).anthropicModel,
    ).toBe("claude-opus-5");
  });

  test("migrates claude-sonnet-4-6 to claude-sonnet-5", () => {
    expect(ok({ anthropicModel: "claude-sonnet-4-6" }).anthropicModel).toBe(
      "claude-sonnet-5",
    );
  });

  test("migrates claude-opus-4-6 to claude-opus-5", () => {
    expect(ok({ anthropicModel: "claude-opus-4-6" }).anthropicModel).toBe(
      "claude-opus-5",
    );
  });

  test("migrates dated haiku identifier to claude-haiku-4-5", () => {
    expect(
      ok({ anthropicModel: "claude-haiku-4-5-20251001" }).anthropicModel,
    ).toBe("claude-haiku-4-5");
  });

  test("does not change current values", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      titlePolicy: "regenerate",
      anthropicModel: "claude-sonnet-5",
    });
    expect(settings.titlePolicy).toBe("regenerate");
    expect(settings.anthropicModel).toBe("claude-sonnet-5");
  });

  test("preserves unrelated settings", () => {
    const settings = ok({
      anthropicApiKeySecret: "anthropic-api-key",
      descriptionFieldName: "summary",
      contentTokenLimit: 500,
    });
    expect(settings.anthropicApiKeySecret).toBe("anthropic-api-key");
    expect(settings.descriptionFieldName).toBe("summary");
    expect(settings.contentTokenLimit).toBe(500);
  });

  test("normalizes invalid trust-boundary settings to defaults", () => {
    const settings = ok({
      // Pinned to the current version so no migration runs: migration 3 sets
      // the policies itself, which would mask the invalid values below.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicApiKey: 123,
      anthropicModel: "not-a-real-model",
      descriptionFieldName: null,
      titleFieldName: ["title"],
      enableTitle: "true",
      debugLogging: "false",
      truncateContent: "yes",
      contentTokenLimit: -10,
      truncateMethod: "bogus",
      descriptionPolicy: "bogus",
      titlePolicy: 7,
      descriptionPrompt: false,
      titlePrompt: null,
    });

    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  // The option lists are the key sets of TRUNCATE_METHOD_LABELS and
  // WRITE_POLICY_LABELS, so membership is an own-property test. Written with
  // `in` instead of Object.hasOwn it would walk the prototype chain and accept
  // every name below as a valid setting.
  test.each(["toString", "constructor", "valueOf", "__proto__"])(
    "rejects the inherited Object property %p as an enum value",
    (inherited) => {
      const settings = ok({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        truncateMethod: inherited,
        descriptionPolicy: inherited,
        titlePolicy: inherited,
      });

      expect(settings.truncateMethod).toBe(DEFAULT_SETTINGS.truncateMethod);
      expect(settings.descriptionPolicy).toBe(
        DEFAULT_SETTINGS.descriptionPolicy,
      );
      expect(settings.titlePolicy).toBe(DEFAULT_SETTINGS.titlePolicy);
    },
  );

  test("preserves valid loaded settings", () => {
    const validLoaded: MetadataToolSettings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicApiKeySecret: "anthropic-api-key",
      anthropicModel: "claude-haiku-4-5",
      descriptionFieldName: "summary",
      titleFieldName: "headline",
      enableDescription: false,
      enableTitle: false,
      debugLogging: true,
      truncateContent: false,
      contentTokenLimit: 42,
      truncateMethod: "heading",
      descriptionPolicy: "preserve",
      titlePolicy: "regenerate",
      descriptionPrompt: "d",
      titlePrompt: "h",
    };

    expect(ok(validLoaded)).toEqual({ ...DEFAULT_SETTINGS, ...validLoaded });
  });

  test("falls back to default for empty or whitespace-only prompts", () => {
    const settings = ok({
      descriptionPrompt: "   ",
      titlePrompt: "\t\n",
    });
    expect(settings.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(settings.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("falls back to default for prompts exceeding max length", () => {
    const tooLong = "x".repeat(PROMPT_MAX_LENGTH + 1);
    const settings = ok({
      descriptionPrompt: tooLong,
      titlePrompt: tooLong,
    });
    expect(settings.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(settings.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("preserves prompts exactly at the max length boundary", () => {
    const atLimit = "x".repeat(PROMPT_MAX_LENGTH);
    expect(ok({ titlePrompt: atLimit }).titlePrompt).toBe(atLimit);
  });

  test("drops the retired maxBulkFiles key (#311)", () => {
    expect(ok({ maxBulkFiles: 250 })).not.toHaveProperty("maxBulkFiles");
  });

  test("stamps the current schemaVersion on migrated output", () => {
    expect(ok({}).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("stamps the current schemaVersion even when input declares an older version", () => {
    const settings = ok({
      schemaVersion: 0,
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(settings.anthropicModel).toBe("claude-sonnet-5");
  });

  test("does not run migrations when input is already at current version", () => {
    // claude-sonnet-4-5-20250929 is the *old* identifier; if the v0→v1
    // migration ran, it would be rewritten to a current one. Since the input
    // already declares schemaVersion=current, the migration is skipped and the
    // value survives untouched — the trust-boundary check only enforces the
    // shape of a model id, not membership in the current lineup.
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(settings.anthropicModel).toBe("claude-sonnet-4-5-20250929");
  });

  test("returns kind:future and warns when schemaVersion is newer than this plugin", () => {
    const captured: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const future = CURRENT_SCHEMA_VERSION + 99;
      const result = migrateSettings({ schemaVersion: future });
      expect(result).toEqual({
        kind: "future",
        loadedSchemaVersion: future,
      });
      expect(captured).toHaveLength(1);
      const message = String(captured[0]?.[0] ?? "");
      expect(message).toContain("schemaVersion=");
      expect(message).toContain("Falling back to defaults");
    } finally {
      console.warn = original;
    }
  });

  test("treats invalid schemaVersion (non-integer / negative) as 0 and migrates", () => {
    expect(
      ok({
        schemaVersion: 1.5,
        anthropicModel: "claude-sonnet-4-5-20250929",
      }).anthropicModel,
    ).toBe("claude-sonnet-5");
    expect(
      ok({
        schemaVersion: -1,
        anthropicModel: "claude-opus-4-5-20251101",
      }).anthropicModel,
    ).toBe("claude-opus-5");
    expect(
      ok({
        schemaVersion: "1",
        anthropicModel: "claude-sonnet-4-5-20250929",
      }).anthropicModel,
    ).toBe("claude-sonnet-5");
  });

  test("drops orphan keys not in MetadataToolSettings", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      removedFieldFromOldVersion: "legacy",
      anotherOrphan: 42,
    });
    expect(settings).not.toHaveProperty("removedFieldFromOldVersion");
    expect(settings).not.toHaveProperty("anotherOrphan");
  });
});

describe("applyMigrations", () => {
  test("throws when a migration entry is missing for a target version", () => {
    // Simulates the bug: someone bumped CURRENT_SCHEMA_VERSION to 3 but
    // forgot to add MIGRATIONS[3]. We want a loud failure, not a silent
    // stamping of v3 onto un-transformed data.
    const partialMigrations = new Map<
      number,
      (s: Record<string, unknown>) => void
    >([
      [
        2,
        (s) => {
          s.touchedByV2 = true;
        },
      ],
    ]);
    expect(() => applyMigrations({}, 1, partialMigrations, 3)).toThrow(
      /missing migration for schema version 3/,
    );
  });

  test("runs every migration in order from fromVersion+1 up to targetVersion", () => {
    const order: number[] = [];
    const migrations = new Map<number, (s: Record<string, unknown>) => void>([
      [
        1,
        () => {
          order.push(1);
        },
      ],
      [
        2,
        () => {
          order.push(2);
        },
      ],
      [
        3,
        () => {
          order.push(3);
        },
      ],
    ]);
    const result = applyMigrations({}, 0, migrations, 3);
    expect(order).toEqual([1, 2, 3]);
    expect(result.schemaVersion).toBe(3);
  });

  test("skips migrations already applied (fromVersion = target)", () => {
    const ran: number[] = [];
    const migrations = new Map<number, (s: Record<string, unknown>) => void>([
      [
        1,
        () => {
          ran.push(1);
        },
      ],
    ]);
    const result = applyMigrations({}, 1, migrations, 1);
    expect(ran).toEqual([]);
    expect(result.schemaVersion).toBe(1);
  });
});

describe("model id validation", () => {
  test("keeps a well-formed model id that predates this build's dropdown", () => {
    expect(
      ok({ schemaVersion: 2, anthropicModel: "claude-fable-5-2" })
        .anthropicModel,
    ).toBe("claude-fable-5-2");
  });

  test("keeps the newly offered fable model", () => {
    expect(
      ok({ schemaVersion: 2, anthropicModel: "claude-fable-5-1" })
        .anthropicModel,
    ).toBe("claude-fable-5-1");
  });

  test("falls back to the default for malformed model ids", () => {
    for (const bad of [
      "",
      "gpt-4",
      "Claude-Opus-5",
      "claude-opus-5; drop table",
      `claude-${"x".repeat(200)}`,
    ]) {
      expect(ok({ schemaVersion: 2, anthropicModel: bad }).anthropicModel).toBe(
        DEFAULT_SETTINGS.anthropicModel,
      );
    }
  });
});

describe("numeric bounds (#184)", () => {
  test("a stored value above the ceiling falls back to the default", () => {
    expect(ok({ contentTokenLimit: 10_000_000 }).contentTokenLimit).toBe(
      DEFAULT_SETTINGS.contentTokenLimit,
    );
  });

  test("a value exactly at the ceiling is kept", () => {
    expect(
      ok({ contentTokenLimit: MAX_CONTENT_TOKEN_LIMIT }).contentTokenLimit,
    ).toBe(MAX_CONTENT_TOKEN_LIMIT);
  });
});

describe("field-name collisions (#200)", () => {
  test("colliding names reset both", () => {
    const s = ok({ descriptionFieldName: "meta", titleFieldName: "meta" });
    expect(s.descriptionFieldName).toBe(DEFAULT_SETTINGS.descriptionFieldName);
    expect(s.titleFieldName).toBe(DEFAULT_SETTINGS.titleFieldName);
  });

  test("distinct custom names are left alone", () => {
    const s = ok({
      descriptionFieldName: "summary",
      titleFieldName: "headline",
    });
    expect(s.descriptionFieldName).toBe("summary");
    expect(s.titleFieldName).toBe("headline");
  });
});

// #281: the key moved to Obsidian's keychain, and a plaintext key in data.json
// is never kept in settings — which is what saveSettings writes back.
describe("a plaintext API key is not kept (#281)", () => {
  test("a v3 key is dropped from settings", () => {
    const key = `sk-ant-${"a".repeat(100)}`;
    const loaded = { schemaVersion: 3, anthropicApiKey: key };
    expect(ok(loaded)).not.toHaveProperty("anthropicApiKey");
    expect(JSON.stringify(ok(loaded))).not.toContain(key);
  });
});

describe("migration 2 → 3: updateMethod becomes a policy per field (#252)", () => {
  test("preserve_existing leaves every field protected", () => {
    const settings = ok({
      schemaVersion: 2,
      updateMethod: "preserve_existing",
    });

    expect(settings.descriptionPolicy).toBe("preserve");
    expect(settings.titlePolicy).toBe("preserve");
  });

  test("always_regenerate moves every field to regenerate", () => {
    const settings = ok({
      schemaVersion: 2,
      updateMethod: "always_regenerate",
    });

    expect(settings.descriptionPolicy).toBe("regenerate");
    expect(settings.titlePolicy).toBe("regenerate");
  });

  test("an absent updateMethod is treated as preserve_existing, its old default", () => {
    const settings = ok({ schemaVersion: 2 });

    expect(settings.descriptionPolicy).toBe("preserve");
    expect(settings.titlePolicy).toBe("preserve");
  });

  test("the retired key does not survive the migration", () => {
    const settings = ok({
      schemaVersion: 2,
      updateMethod: "always_regenerate",
    });

    expect("updateMethod" in settings).toBe(false);
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  // A fresh install has no data.json at all, so migrateSettings returns
  // kind:"missing" and DEFAULT_SETTINGS applies — the migration must not be
  // what decides a new user's policies.
  test("a brand-new install gets the defaults, not the migration's output", () => {
    expect(migrateSettings(null)).toEqual({ kind: "missing" });
    expect(DEFAULT_SETTINGS.descriptionPolicy).toBe("regenerate");
    expect(DEFAULT_SETTINGS.titlePolicy).toBe("preserve");
  });
});

describe("field-name collision with a field disabled (#248, #305)", () => {
  test("title off: keeps the name in use and resets only the inert one", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableTitle: false,
      descriptionFieldName: "summary",
      titleFieldName: "summary",
    });

    // This used to be destroyed to fix a value nothing reads.
    expect(settings.descriptionFieldName).toBe("summary");
    expect(settings.titleFieldName).toBe(DEFAULT_SETTINGS.titleFieldName);
  });

  test("description off: keeps the name in use and resets only the inert one", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableDescription: false,
      descriptionFieldName: "headline",
      titleFieldName: "headline",
    });

    expect(settings.descriptionFieldName).toBe(
      DEFAULT_SETTINGS.descriptionFieldName,
    );
    expect(settings.titleFieldName).toBe("headline");
  });

  test("both off and sharing a name: both reset", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableDescription: false,
      enableTitle: false,
      descriptionFieldName: "x",
      titleFieldName: "x",
    });

    expect(settings.descriptionFieldName).toBe(
      DEFAULT_SETTINGS.descriptionFieldName,
    );
    expect(settings.titleFieldName).toBe(DEFAULT_SETTINGS.titleFieldName);
  });

  test("with both on, a collision resets both", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableTitle: true,
      descriptionFieldName: "summary",
      titleFieldName: "summary",
    });

    expect(settings.descriptionFieldName).toBe(
      DEFAULT_SETTINGS.descriptionFieldName,
    );
    expect(settings.titleFieldName).toBe(DEFAULT_SETTINGS.titleFieldName);
  });

  test("a valid inert titleFieldName is left alone", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableTitle: false,
      descriptionFieldName: "summary",
      titleFieldName: "headline",
    });

    expect(settings.titleFieldName).toBe("headline");
  });
});

describe("schema v5: the description toggle (#305)", () => {
  test("a v4 file gains the toggle, on", () => {
    const settings = ok({ schemaVersion: 4, enableTitle: false });

    expect(settings.enableDescription).toBe(true);
    expect(settings.enableTitle).toBe(false);
  });

  test("the v5 migration keeps a value already present", () => {
    const migrated = applyMigrations({ enableDescription: false }, 4);
    expect(migrated.enableDescription).toBe(false);
  });

  test("the toggle survives a reload at the current version", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableDescription: false,
    });
    expect(settings.enableDescription).toBe(false);
  });

  test("a non-boolean toggle falls back to on", () => {
    const settings = ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enableDescription: 0,
    });
    expect(settings.enableDescription).toBe(true);
  });
});

describe("schema v6: tag generation removed (#310)", () => {
  const v5 = {
    schemaVersion: 5,
    tagsFieldName: "keywords",
    enableTags: false,
    tagsPolicy: "merge",
    tagsPrompt: "Select 3-5 tags.",
    descriptionFieldName: "summary",
    descriptionPolicy: "preserve",
  };
  const tagKeys = ["tagsFieldName", "enableTags", "tagsPolicy", "tagsPrompt"];

  test("the v6 migration deletes the four tag keys from the raw bag", () => {
    const migrated = applyMigrations(v5, 5);
    expect(migrated.schemaVersion).toBe(6);
    for (const key of tagKeys) expect(migrated).not.toHaveProperty(key);
    expect(migrated.descriptionFieldName).toBe("summary");
    expect(migrated.descriptionPolicy).toBe("preserve");
  });

  test("a v5 file loads at v6 without them, other settings kept", () => {
    const settings = ok(v5);
    expect(settings.schemaVersion).toBe(6);
    for (const key of tagKeys) expect(settings).not.toHaveProperty(key);
    expect(settings.descriptionFieldName).toBe("summary");
    expect(settings.descriptionPolicy).toBe("preserve");
  });

  test("an older file carrying tag keys loses them too", () => {
    const settings = ok({ schemaVersion: 2, tagsPolicy: "merge" });
    for (const key of tagKeys) expect(settings).not.toHaveProperty(key);
  });
});
