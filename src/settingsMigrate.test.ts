import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  MAX_BULK_FILES,
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
      updateMethod: "always_regenerate",
      anthropicModel: "claude-sonnet-5",
    });
    expect(settings.updateMethod).toBe("always_regenerate");
    expect(settings.anthropicModel).toBe("claude-sonnet-5");
  });

  test("preserves unrelated settings", () => {
    const settings = ok({
      anthropicApiKey: "sk-test",
      tagsFieldName: "tags",
      contentTokenLimit: 500,
    });
    expect(settings.anthropicApiKey).toBe("sk-test");
    expect(settings.tagsFieldName).toBe("tags");
    expect(settings.contentTokenLimit).toBe(500);
  });

  test("normalizes invalid trust-boundary settings to defaults", () => {
    const settings = ok({
      anthropicApiKey: 123,
      anthropicModel: "not-a-real-model",
      tagsFieldName: false,
      descriptionFieldName: null,
      titleFieldName: ["title"],
      enableTitle: "true",
      debugLogging: "false",
      truncateContent: "yes",
      contentTokenLimit: -10,
      truncateMethod: "bogus",
      updateMethod: "overwrite",
      tagsPrompt: 123,
      descriptionPrompt: false,
      titlePrompt: null,
    });

    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test("preserves valid loaded settings", () => {
    const validLoaded: MetadataToolSettings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicApiKey: "sk-test",
      anthropicModel: "claude-haiku-4-5",
      tagsFieldName: "keywords",
      descriptionFieldName: "summary",
      titleFieldName: "headline",
      enableTitle: false,
      debugLogging: true,
      truncateContent: false,
      contentTokenLimit: 42,
      truncateMethod: "heading",
      updateMethod: "always_regenerate",
      maxBulkFiles: 250,
      tagsPrompt: "t",
      descriptionPrompt: "d",
      titlePrompt: "h",
    };

    expect(ok(validLoaded)).toEqual({ ...DEFAULT_SETTINGS, ...validLoaded });
  });

  test("falls back to default for empty or whitespace-only prompts", () => {
    const settings = ok({
      tagsPrompt: "",
      descriptionPrompt: "   ",
      titlePrompt: "\t\n",
    });
    expect(settings.tagsPrompt).toBe(DEFAULT_SETTINGS.tagsPrompt);
    expect(settings.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(settings.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("falls back to default for prompts exceeding max length", () => {
    const tooLong = "x".repeat(PROMPT_MAX_LENGTH + 1);
    const settings = ok({
      tagsPrompt: tooLong,
      descriptionPrompt: tooLong,
      titlePrompt: tooLong,
    });
    expect(settings.tagsPrompt).toBe(DEFAULT_SETTINGS.tagsPrompt);
    expect(settings.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(settings.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("preserves prompts exactly at the max length boundary", () => {
    const atLimit = "x".repeat(PROMPT_MAX_LENGTH);
    expect(ok({ tagsPrompt: atLimit }).tagsPrompt).toBe(atLimit);
  });

  test("maxBulkFiles: preserves a valid positive integer", () => {
    expect(ok({ maxBulkFiles: 1000 }).maxBulkFiles).toBe(1000);
  });

  test("maxBulkFiles: falls back to default for non-positive or non-integer values", () => {
    expect(ok({ maxBulkFiles: 0 }).maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(ok({ maxBulkFiles: -5 }).maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(ok({ maxBulkFiles: 3.5 }).maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(ok({ maxBulkFiles: "100" }).maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
  });

  test("maxBulkFiles: defaults when key is missing entirely", () => {
    expect(ok({}).maxBulkFiles).toBe(DEFAULT_SETTINGS.maxBulkFiles);
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
      const message = String(captured[0][0] ?? "");
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
    expect(ok({ maxBulkFiles: 1_000_000 }).maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(ok({ contentTokenLimit: 10_000_000 }).contentTokenLimit).toBe(
      DEFAULT_SETTINGS.contentTokenLimit,
    );
  });

  test("a value exactly at the ceiling is kept", () => {
    expect(ok({ maxBulkFiles: MAX_BULK_FILES }).maxBulkFiles).toBe(
      MAX_BULK_FILES,
    );
    expect(
      ok({ contentTokenLimit: MAX_CONTENT_TOKEN_LIMIT }).contentTokenLimit,
    ).toBe(MAX_CONTENT_TOKEN_LIMIT);
  });
});

describe("field-name collisions (#200)", () => {
  test("colliding names reset all three, not just the pair", () => {
    // Resetting only the second collider is order-dependent and can produce a
    // fresh collision; resetting all three cannot, since the defaults differ.
    const s = ok({
      tagsFieldName: "meta",
      descriptionFieldName: "meta",
      titleFieldName: "headline",
    });
    expect(s.tagsFieldName).toBe(DEFAULT_SETTINGS.tagsFieldName);
    expect(s.descriptionFieldName).toBe(DEFAULT_SETTINGS.descriptionFieldName);
    expect(s.titleFieldName).toBe(DEFAULT_SETTINGS.titleFieldName);
  });

  test("distinct custom names are left alone", () => {
    const s = ok({
      tagsFieldName: "keywords",
      descriptionFieldName: "summary",
      titleFieldName: "headline",
    });
    expect(s.tagsFieldName).toBe("keywords");
    expect(s.descriptionFieldName).toBe("summary");
    expect(s.titleFieldName).toBe("headline");
  });
});
