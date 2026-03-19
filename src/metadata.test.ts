import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  isEmptyValue,
  parseMetadataResponse,
  parseTags,
  resolveUpdateMethod,
  stripSurroundingQuotes,
} from "./metadata";
import { DEFAULT_SETTINGS } from "./settings";

describe("parseMetadataResponse", () => {
  test("parses clean JSON", () => {
    const response = '{"tags": "a,b", "description": "test"}';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "a,b",
      description: "test",
    });
  });

  test("parses JSON wrapped in code fences", () => {
    const response = '```json\n{"tags": "a,b", "description": "test"}\n```';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "a,b",
      description: "test",
    });
  });

  test("parses JSON with surrounding text", () => {
    const response =
      'Here is the metadata:\n{"tags": "a,b", "description": "test"}\nHope this helps!';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "a,b",
      description: "test",
    });
  });

  test("returns null when no JSON found", () => {
    expect(parseMetadataResponse("no json here")).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseMetadataResponse("{tags: malformed}")).toBeNull();
  });

  test("preserves backticks inside values", () => {
    const response = '{"tags": "code", "description": "Use `foo` for bar"}';
    const result = parseMetadataResponse(response);
    expect(result?.description).toBe("Use `foo` for bar");
  });

  test("parses JSON with all three fields", () => {
    const response =
      '{"tags": "a,b", "description": "desc", "title": "My Title"}';
    const result = parseMetadataResponse(response);
    expect(result).toEqual({
      tags: "a,b",
      description: "desc",
      title: "My Title",
    });
  });

  test("handles code fences without json specifier", () => {
    const response = '```\n{"tags": "a", "description": "b"}\n```';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "a",
      description: "b",
    });
  });

  test("preserves triple backticks inside JSON values", () => {
    const response =
      '{"tags": "code", "description": "Use ```code``` in markdown"}';
    const result = parseMetadataResponse(response);
    expect(result?.description).toBe("Use ```code``` in markdown");
  });

  test("handles multiple JSON objects in response (greedy regex bug)", () => {
    const response =
      'Here\'s an example: {"not": "this"} and here\'s the answer: {"tags": "a,b", "description": "correct"}';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "a,b",
      description: "correct",
    });
  });

  test("handles prose with braces before valid JSON", () => {
    const response =
      'The format is {key: value}. Here is the result: {"tags": "x", "description": "y"}';
    expect(parseMetadataResponse(response)).toEqual({
      tags: "x",
      description: "y",
    });
  });

  test("returns null when field types are invalid", () => {
    expect(parseMetadataResponse('{"tags": 42}')).toBeNull();
    expect(parseMetadataResponse('{"description": null}')).toBeNull();
    expect(parseMetadataResponse('{"title": ["array"]}')).toBeNull();
  });
});

describe("parseTags", () => {
  test("splits comma-separated tags", () => {
    expect(parseTags("one,two,three")).toEqual(["one", "two", "three"]);
  });

  test("trims whitespace from tags", () => {
    expect(parseTags(" one , two , three ")).toEqual(["one", "two", "three"]);
  });

  test("handles single tag", () => {
    expect(parseTags("only")).toEqual(["only"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseTags("")).toEqual([]);
  });

  test("filters empty entries from trailing comma", () => {
    expect(parseTags("one,two,")).toEqual(["one", "two"]);
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
    expect(stripSurroundingQuotes("\"hello'")).toBe("\"hello'");
  });

  test("handles empty quoted string", () => {
    expect(stripSurroundingQuotes('""')).toBe("");
  });

  test("trims whitespace before checking quotes", () => {
    expect(stripSurroundingQuotes('  "hello"  ')).toBe("hello");
  });

  test("does not strip interior quotes", () => {
    expect(stripSurroundingQuotes('say "hi" please')).toBe('say "hi" please');
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

  test("includes tags and description prompts", () => {
    const prompt = buildPrompt("my content", baseSettings);
    expect(prompt).toContain("1. Tags:");
    expect(prompt).toContain(baseSettings.tagsPrompt);
    expect(prompt).toContain("2. Description:");
    expect(prompt).toContain(baseSettings.descriptionPrompt);
  });

  test("excludes title when disabled", () => {
    const settings = { ...baseSettings, enableTitle: false };
    const prompt = buildPrompt("my content", settings);
    expect(prompt).not.toContain("3. Title:");
    expect(prompt).not.toContain('"title"');
  });

  test("includes title when enabled", () => {
    const settings = { ...baseSettings, enableTitle: true };
    const prompt = buildPrompt("my content", settings);
    expect(prompt).toContain("3. Title:");
    expect(prompt).toContain(settings.titlePrompt);
    expect(prompt).toContain('"title"');
  });

  test("includes content in prompt", () => {
    const prompt = buildPrompt("the article text", baseSettings);
    expect(prompt).toContain("the article text");
    expect(prompt).toContain("Article content:");
  });

  test("includes JSON template", () => {
    const prompt = buildPrompt("content", baseSettings);
    expect(prompt).toContain('"tags": "tag1,tag2,tag3"');
    expect(prompt).toContain('"description": "brief summary"');
  });
});
