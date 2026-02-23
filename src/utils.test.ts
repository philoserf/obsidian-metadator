import { describe, expect, test } from "bun:test";
import {
  joinTokens,
  splitIntoTokens,
  truncateHeading,
  truncateHeadOnly,
  truncateHeadTail,
} from "./utils";

describe("splitIntoTokens", () => {
  test("splits English words", () => {
    expect(splitIntoTokens("hello world")).toEqual(["hello", "world"]);
  });

  test("splits CJK characters individually", () => {
    expect(splitIntoTokens("你好世界")).toEqual(["你", "好", "世", "界"]);
  });

  test("handles mixed English and CJK", () => {
    expect(splitIntoTokens("hello你好world")).toEqual([
      "hello",
      "你",
      "好",
      "world",
    ]);
  });

  test("captures punctuation as separate tokens", () => {
    expect(splitIntoTokens("hello, world!")).toEqual([
      "hello",
      ",",
      "world",
      "!",
    ]);
  });

  test("captures newlines as tokens", () => {
    expect(splitIntoTokens("hello\nworld")).toEqual(["hello", "\n", "world"]);
  });

  test("returns empty array for empty string", () => {
    expect(splitIntoTokens("")).toEqual([]);
  });

  test("returns empty array for whitespace-only string", () => {
    expect(splitIntoTokens("   ")).toEqual([]);
  });

  test("captures hash as punctuation token", () => {
    expect(splitIntoTokens("# heading")).toEqual(["#", "heading"]);
  });

  test("handles CJK punctuation", () => {
    expect(splitIntoTokens("你好，世界！")).toEqual([
      "你",
      "好",
      "，",
      "世",
      "界",
      "！",
    ]);
  });
});

describe("joinTokens", () => {
  test("joins English words with spaces", () => {
    expect(joinTokens(["hello", "world"])).toBe("hello world");
  });

  test("joins CJK characters without spaces", () => {
    expect(joinTokens(["你", "好", "世", "界"])).toBe("你好世界");
  });

  test("attaches punctuation without leading space", () => {
    expect(joinTokens(["hello", ",", "world"])).toBe("hello, world");
  });

  test("preserves newlines", () => {
    expect(joinTokens(["hello", "\n", "world"])).toBe("hello\nworld");
  });

  test("returns empty string for empty array", () => {
    expect(joinTokens([])).toBe("");
  });

  test("handles mixed content", () => {
    expect(joinTokens(["hello", "你", "好", "world"])).toBe("hello你好 world");
  });

  test("handles single token", () => {
    expect(joinTokens(["hello"])).toBe("hello");
  });
});

describe("truncateHeadOnly", () => {
  test("returns first N tokens with ellipsis", () => {
    const tokens = ["one", "two", "three", "four", "five"];
    expect(truncateHeadOnly(tokens, 3)).toBe("one two three...");
  });

  test("handles limit of 1", () => {
    const tokens = ["one", "two", "three"];
    expect(truncateHeadOnly(tokens, 1)).toBe("one...");
  });

  test("returns all tokens when limit equals length", () => {
    const tokens = ["one", "two", "three"];
    expect(truncateHeadOnly(tokens, 3)).toBe("one two three...");
  });

  test("returns all tokens when limit exceeds length", () => {
    const tokens = ["one", "two"];
    expect(truncateHeadOnly(tokens, 10)).toBe("one two...");
  });
});

describe("truncateHeadTail", () => {
  test("splits 80/20 with separator", () => {
    const tokens = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const result = truncateHeadTail(tokens, 10);
    // 80% of 10 = 8, 20% of 10 = 2
    expect(result).toContain("t0");
    expect(result).toContain("t7"); // 8th token (0-indexed)
    expect(result).toContain("\n...\n");
    expect(result).toContain("t9"); // last token
  });

  test("handles small limit", () => {
    const tokens = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const result = truncateHeadTail(tokens, 5);
    // 80% of 5 = 4, 20% of 5 = 1
    expect(result).toContain("a");
    expect(result).toContain("\n...\n");
  });

  test("handles limit of 1", () => {
    const tokens = ["a", "b", "c", "d", "e"];
    const result = truncateHeadTail(tokens, 1);
    // All budget goes to head, tail is empty
    expect(result).toContain("a");
    expect(result).toContain("\n...\n");
    expect(result).not.toContain("e");
  });
});

describe("truncateHeading", () => {
  test("extracts headings and first paragraph", () => {
    const content =
      "# Title\nSome paragraph text here for testing.\n\n## Section\nMore text in section.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
    expect(result).toContain("## Section");
    expect(result).toContain("Outline:");
    expect(result).toContain("Body:");
  });

  test("truncates when outline exceeds limit", () => {
    const content = "# H1\nParagraph one.\n# H2\nParagraph two.";
    const tokens = splitIntoTokens(content);
    // Very small limit to force truncation of the outline itself
    const result = truncateHeading(content, tokens, 2);
    // Should just be the first 2 tokens from the outline
    expect(result.length).toBeGreaterThan(0);
  });

  test("filters empty lines", () => {
    const content = "# Title\n\n\n\nParagraph after blanks.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
  });

  test("handles content with no headings", () => {
    const content = "Just a plain paragraph with no headings at all.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    // No headings → empty outline, all budget goes to body
    expect(result).toContain("Body:");
  });
});
