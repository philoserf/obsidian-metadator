import { describe, expect, test } from "bun:test";
import { migrateSettings } from "./main";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  type MetadataToolSettings,
  PROMPT_MAX_LENGTH,
} from "./settings";

describe("migrateSettings", () => {
  test("returns null for null input", () => {
    expect(migrateSettings(null)).toBeNull();
  });

  test("migrates old sonnet model to claude-sonnet-4-6", () => {
    const result = migrateSettings({
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(result?.anthropicModel).toBe("claude-sonnet-4-6");
  });

  test("migrates old opus model to claude-opus-4-6", () => {
    const result = migrateSettings({
      anthropicModel: "claude-opus-4-5-20251101",
    });
    expect(result?.anthropicModel).toBe("claude-opus-4-6");
  });

  test("does not change current values", () => {
    const result = migrateSettings({
      updateMethod: "always_regenerate",
      anthropicModel: "claude-sonnet-4-6",
    });
    expect(result?.updateMethod).toBe("always_regenerate");
    expect(result?.anthropicModel).toBe("claude-sonnet-4-6");
  });

  test("preserves unrelated settings", () => {
    const result = migrateSettings({
      anthropicApiKey: "sk-test",
      tagsFieldName: "tags",
      contentTokenLimit: 500,
    });
    expect(result?.anthropicApiKey).toBe("sk-test");
    expect(result?.tagsFieldName).toBe("tags");
    expect(result?.contentTokenLimit).toBe(500);
  });

  test("normalizes invalid trust-boundary settings to defaults", () => {
    const result = migrateSettings({
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

    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  test("preserves valid loaded settings", () => {
    const validLoaded: MetadataToolSettings = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicApiKey: "sk-test",
      anthropicModel: "claude-haiku-4-5-20251001",
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
    const result = migrateSettings(validLoaded);

    expect(result).toEqual({ ...DEFAULT_SETTINGS, ...validLoaded });
  });

  test("falls back to default for empty or whitespace-only prompts", () => {
    const result = migrateSettings({
      tagsPrompt: "",
      descriptionPrompt: "   ",
      titlePrompt: "\t\n",
    });
    expect(result?.tagsPrompt).toBe(DEFAULT_SETTINGS.tagsPrompt);
    expect(result?.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(result?.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("falls back to default for prompts exceeding max length", () => {
    const tooLong = "x".repeat(PROMPT_MAX_LENGTH + 1);
    const result = migrateSettings({
      tagsPrompt: tooLong,
      descriptionPrompt: tooLong,
      titlePrompt: tooLong,
    });
    expect(result?.tagsPrompt).toBe(DEFAULT_SETTINGS.tagsPrompt);
    expect(result?.descriptionPrompt).toBe(DEFAULT_SETTINGS.descriptionPrompt);
    expect(result?.titlePrompt).toBe(DEFAULT_SETTINGS.titlePrompt);
  });

  test("preserves prompts exactly at the max length boundary", () => {
    const atLimit = "x".repeat(PROMPT_MAX_LENGTH);
    const result = migrateSettings({
      tagsPrompt: atLimit,
    });
    expect(result?.tagsPrompt).toBe(atLimit);
  });

  test("maxBulkFiles: preserves a valid positive integer", () => {
    const result = migrateSettings({ maxBulkFiles: 1000 });
    expect(result?.maxBulkFiles).toBe(1000);
  });

  test("maxBulkFiles: falls back to default for non-positive or non-integer values", () => {
    expect(migrateSettings({ maxBulkFiles: 0 })?.maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(migrateSettings({ maxBulkFiles: -5 })?.maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(migrateSettings({ maxBulkFiles: 3.5 })?.maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
    expect(migrateSettings({ maxBulkFiles: "100" })?.maxBulkFiles).toBe(
      DEFAULT_SETTINGS.maxBulkFiles,
    );
  });

  test("maxBulkFiles: defaults when key is missing entirely", () => {
    const result = migrateSettings({});
    expect(result?.maxBulkFiles).toBe(DEFAULT_SETTINGS.maxBulkFiles);
  });

  test("stamps the current schemaVersion on migrated output", () => {
    const result = migrateSettings({});
    expect(result?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("stamps the current schemaVersion even when input declares an older version", () => {
    const result = migrateSettings({
      schemaVersion: 0,
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(result?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result?.anthropicModel).toBe("claude-sonnet-4-6");
  });

  test("does not run migrations when input is already at current version", () => {
    // claude-sonnet-4-5-20250929 is the *old* identifier; if the v0→v1
    // migration ran, it would be rewritten. Since the input already declares
    // schemaVersion=current, the migration is skipped — and then the
    // trust-boundary check rejects the unknown model and falls back to default.
    const result = migrateSettings({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(result?.anthropicModel).toBe(DEFAULT_SETTINGS.anthropicModel);
  });

  test("returns null and warns when schemaVersion is newer than this plugin", () => {
    const captured: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const result = migrateSettings({
        schemaVersion: CURRENT_SCHEMA_VERSION + 99,
      });
      expect(result).toBeNull();
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
      migrateSettings({
        schemaVersion: 1.5,
        anthropicModel: "claude-sonnet-4-5-20250929",
      })?.anthropicModel,
    ).toBe("claude-sonnet-4-6");
    expect(
      migrateSettings({
        schemaVersion: -1,
        anthropicModel: "claude-opus-4-5-20251101",
      })?.anthropicModel,
    ).toBe("claude-opus-4-6");
    expect(
      migrateSettings({
        schemaVersion: "1",
        anthropicModel: "claude-sonnet-4-5-20250929",
      })?.anthropicModel,
    ).toBe("claude-sonnet-4-6");
  });

  test("drops orphan keys not in MetadataToolSettings", () => {
    const result = migrateSettings({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      removedFieldFromOldVersion: "legacy",
      anotherOrphan: 42,
    });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("removedFieldFromOldVersion");
    expect(result).not.toHaveProperty("anotherOrphan");
  });
});
