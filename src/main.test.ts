import { describe, expect, test } from "bun:test";
import { migrateSettings } from "./main";
import {
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
});
