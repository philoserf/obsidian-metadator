import { describe, expect, test } from "bun:test";
import { migrateSettings } from "./main";

describe("migrateSettings", () => {
  test("returns null for null input", () => {
    expect(migrateSettings(null)).toBeNull();
  });

  test('migrates "force" to "always_regenerate"', () => {
    const result = migrateSettings({ updateMethod: "force" });
    expect(result?.updateMethod).toBe("always_regenerate");
  });

  test('migrates "update_all" to "always_regenerate"', () => {
    const result = migrateSettings({ updateMethod: "update_all" });
    expect(result?.updateMethod).toBe("always_regenerate");
  });

  test('migrates "no-llm" to "preserve_existing"', () => {
    const result = migrateSettings({ updateMethod: "no-llm" });
    expect(result?.updateMethod).toBe("preserve_existing");
  });

  test('migrates "empty_only" to "preserve_existing"', () => {
    const result = migrateSettings({ updateMethod: "empty_only" });
    expect(result?.updateMethod).toBe("preserve_existing");
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

  test("applies both migrations at once", () => {
    const result = migrateSettings({
      updateMethod: "force",
      anthropicModel: "claude-sonnet-4-5-20250929",
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

  test("migrates maxTokens to contentTokenLimit", () => {
    const result = migrateSettings({ maxTokens: 500 });
    expect(result?.contentTokenLimit).toBe(500);
    expect(result?.maxTokens).toBeUndefined();
  });

  test("does not overwrite existing contentTokenLimit with maxTokens", () => {
    const result = migrateSettings({
      maxTokens: 500,
      contentTokenLimit: 2000,
    });
    expect(result?.contentTokenLimit).toBe(2000);
  });
});
