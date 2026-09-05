import { describe, expect, test } from "bun:test";
import { buildPrompt, parseTags } from "./prompt";
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
