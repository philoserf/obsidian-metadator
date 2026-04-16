import { describe, expect, test } from "bun:test";
import { migrateSettings } from "./main";

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
});
