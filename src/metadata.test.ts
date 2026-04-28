import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  isEmptyValue,
  parseTags,
  resolveUpdateMethod,
  stripSurroundingQuotes,
} from "./metadata";
import { DEFAULT_SETTINGS } from "./settings";

describe("parseTags", () => {
  test("splits comma-separated tags", () => {
    expect(parseTags("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("trims whitespace from tags", () => {
    expect(parseTags(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  test("handles single tag", () => {
    expect(parseTags("only")).toEqual(["only"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseTags("")).toEqual([]);
  });

  test("filters empty entries from trailing comma", () => {
    expect(parseTags("a,b,")).toEqual(["a", "b"]);
  });
});

describe("stripSurroundingQuotes", () => {
  test("removes double quotes", () => {
    expect(stripSurroundingQuotes('"hello"')).toBe("hello");
  });

  test("removes single quotes", () => {
    expect(stripSurroundingQuotes("'hello'")).toBe("hello");
  });

  test("returns unquoted string as-is", () => {
    expect(stripSurroundingQuotes("hello")).toBe("hello");
  });

  test("does not strip mismatched quotes", () => {
    expect(stripSurroundingQuotes("'hello\"")).toBe("'hello\"");
  });

  test("handles empty quoted string", () => {
    expect(stripSurroundingQuotes('""')).toBe("");
  });

  test("trims whitespace before checking quotes", () => {
    expect(stripSurroundingQuotes('  "hello"  ')).toBe("hello");
  });

  test("does not strip interior quotes", () => {
    expect(stripSurroundingQuotes('he"llo')).toBe('he"llo');
  });
});

describe("resolveUpdateMethod", () => {
  test("returns update when force is true", () => {
    expect(resolveUpdateMethod(true, "existing")).toBe("update");
  });

  test("returns update when currentValue is undefined", () => {
    expect(resolveUpdateMethod(false, undefined)).toBe("update");
  });

  test("returns update when currentValue is null", () => {
    expect(resolveUpdateMethod(false, null)).toBe("update");
  });

  test("returns update when currentValue is empty string", () => {
    expect(resolveUpdateMethod(false, "")).toBe("update");
  });

  test("returns update when currentValue is whitespace-only", () => {
    expect(resolveUpdateMethod(false, "   ")).toBe("update");
  });

  test("returns keep when currentValue exists", () => {
    expect(resolveUpdateMethod(false, "existing value")).toBe("keep");
  });

  test("returns keep for non-string truthy value", () => {
    expect(resolveUpdateMethod(false, ["tag1", "tag2"])).toBe("keep");
  });

  test("force overrides existing value", () => {
    expect(resolveUpdateMethod(true, "existing value")).toBe("update");
  });
});

describe("isEmptyValue", () => {
  test("returns true for null", () => {
    expect(isEmptyValue(null)).toBe(true);
  });

  test("returns true for undefined", () => {
    expect(isEmptyValue(undefined)).toBe(true);
  });

  test("returns true for empty string", () => {
    expect(isEmptyValue("")).toBe(true);
  });

  test("returns true for whitespace-only string", () => {
    expect(isEmptyValue("   ")).toBe(true);
  });

  test("returns true for empty array", () => {
    expect(isEmptyValue([])).toBe(true);
  });

  test("returns true for array of empty strings", () => {
    expect(isEmptyValue(["", "  "])).toBe(true);
  });

  test("returns false for non-empty string", () => {
    expect(isEmptyValue("hello")).toBe(false);
  });

  test("returns false for array with content", () => {
    expect(isEmptyValue(["tag1", "tag2"])).toBe(false);
  });

  test("returns false for mixed array with at least one non-empty", () => {
    expect(isEmptyValue(["", "tag1"])).toBe(false);
  });
});

describe("buildPrompt", () => {
  const baseSettings = { ...DEFAULT_SETTINGS };

  test("returns system and userMessage parts", () => {
    const result = buildPrompt("my content", baseSettings);
    expect(result).toHaveProperty("system");
    expect(result).toHaveProperty("userMessage");
  });

  test("includes tags and description prompts in system", () => {
    const { system } = buildPrompt("my content", baseSettings);
    expect(system).toContain("1. Tags:");
    expect(system).toContain(baseSettings.tagsPrompt);
    expect(system).toContain("2. Description:");
    expect(system).toContain(baseSettings.descriptionPrompt);
  });

  test("excludes title when disabled", () => {
    const settings = { ...baseSettings, enableTitle: false };
    const { system } = buildPrompt("my content", settings);
    expect(system).not.toContain("3. Title:");
  });

  test("includes title when enabled", () => {
    const settings = { ...baseSettings, enableTitle: true };
    const { system } = buildPrompt("my content", settings);
    expect(system).toContain("3. Title:");
    expect(system).toContain(settings.titlePrompt);
  });

  test("wraps content in XML article tags", () => {
    const { userMessage } = buildPrompt("the article text", baseSettings);
    expect(userMessage).toContain("<article>");
    expect(userMessage).toContain("the article text");
    expect(userMessage).toContain("</article>");
  });

  test("references the submit_metadata tool", () => {
    const { system } = buildPrompt("content", baseSettings);
    expect(system).toContain("submit_metadata");
  });
});
