import { describe, expect, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { getContent } from "./content/getContent";
import { joinTokens, splitIntoTokens } from "./content/tokens";
import {
  truncateHeading,
  truncateHeadOnly,
  truncateHeadTail,
} from "./content/truncate";

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

  test("preserves Cyrillic words", () => {
    expect(splitIntoTokens("Привет мир")).toEqual(["Привет", "мир"]);
  });

  test("preserves Latin accented characters within a word", () => {
    expect(splitIntoTokens("café résumé")).toEqual(["café", "résumé"]);
  });

  test("preserves Greek words", () => {
    expect(splitIntoTokens("γειά σου")).toEqual(["γειά", "σου"]);
  });

  test("preserves Hebrew words", () => {
    expect(splitIntoTokens("שלום עולם")).toEqual(["שלום", "עולם"]);
  });

  test("preserves Arabic words", () => {
    expect(splitIntoTokens("مرحبا بالعالم")).toEqual(["مرحبا", "بالعالم"]);
  });

  test("preserves Devanagari words including combining marks", () => {
    expect(splitIntoTokens("नमस्ते दुनिया")).toEqual(["नमस्ते", "दुनिया"]);
  });

  test("preserves Thai words", () => {
    expect(splitIntoTokens("สวัสดี")).toEqual(["สวัสดี"]);
  });

  test("splits Hiragana per character", () => {
    expect(splitIntoTokens("こんにちは")).toEqual([
      "こ",
      "ん",
      "に",
      "ち",
      "は",
    ]);
  });

  test("splits Katakana per character", () => {
    expect(splitIntoTokens("カタカナ")).toEqual(["カ", "タ", "カ", "ナ"]);
  });

  test("splits Hangul syllables per character", () => {
    expect(splitIntoTokens("안녕하세요")).toEqual([
      "안",
      "녕",
      "하",
      "세",
      "요",
    ]);
  });

  test("keeps letter-and-digit words as a single token", () => {
    expect(splitIntoTokens("abc123 word")).toEqual(["abc123", "word"]);
  });

  test("matches non-Latin digits as part of words", () => {
    expect(splitIntoTokens("١٢٣")).toEqual(["١٢٣"]);
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

  test("joins Hiragana characters without spaces", () => {
    expect(joinTokens(["こ", "ん", "に", "ち", "は"])).toBe("こんにちは");
  });

  test("joins Hangul syllables without spaces", () => {
    expect(joinTokens(["안", "녕"])).toBe("안녕");
  });

  test("joins Cyrillic words with spaces", () => {
    expect(joinTokens(["Привет", "мир"])).toBe("Привет мир");
  });

  test("round-trips mixed Latin and Cyrillic", () => {
    const original = "Hello, мир!";
    expect(joinTokens(splitIntoTokens(original))).toBe(original);
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
    expect(truncateHeadOnly(tokens, 3)).toBe("one two three");
  });

  test("returns all tokens when limit exceeds length", () => {
    const tokens = ["one", "two"];
    expect(truncateHeadOnly(tokens, 10)).toBe("one two");
  });
});

describe("truncateHeadTail", () => {
  test("returns full content when limit covers all tokens", () => {
    const tokens = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const result = truncateHeadTail(tokens, 10);
    expect(result).toBe(joinTokens(tokens));
    expect(result).not.toContain("...");
  });

  test("returns full content when limit exceeds token count", () => {
    const tokens = ["a", "b", "c"];
    const result = truncateHeadTail(tokens, 100);
    expect(result).toBe(joinTokens(tokens));
    expect(result).not.toContain("...");
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
    // All budget goes to head, tail is empty — no separator
    expect(result).toBe("a");
    expect(result).not.toContain("\n...\n");
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
    // No Body section: every source line is either a heading or a first
    // paragraph captured by the outline, so there is no remaining content.
    expect(result).not.toContain("Body:");
  });

  test("truncates when outline exceeds limit", () => {
    const content = "# H1\nParagraph one.\n# H2\nParagraph two.";
    const tokens = splitIntoTokens(content);
    // Very small limit to force truncation of the outline itself
    const result = truncateHeading(content, tokens, 2);
    const resultTokens = splitIntoTokens(result);
    // Output should be truncated to at most the token limit
    expect(resultTokens.length).toBeLessThanOrEqual(2);
    // Should not contain the Outline:/Body: wrapper since outline exceeded limit
    expect(result).not.toContain("Outline:");
    expect(result).not.toContain("Body:");
  });

  test("filters empty lines", () => {
    const content = "# Title\n\n\n\nParagraph after blanks.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
  });

  test("does not append ellipsis to short paragraphs", () => {
    const content = "# Title\nShort paragraph.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    // "Short paragraph." is < 30 tokens, should not get "..."
    expect(result).toContain("Short paragraph.");
    expect(result).not.toMatch(/Short paragraph\.\.\.\./);
  });

  test("omits body when outline consumes entire budget", () => {
    // Outline for "# A\nword" is ["# A", "word"] → "# A\nword"
    // tokenized: ["#", "A", "\n", "word"] = 4 tokens
    // limit=4 → remainingTokens=0 → no body section
    const content = "# A\nword";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 4);
    expect(result).toContain("Outline:");
    expect(result).not.toContain("Body:");
  });

  test("handles content with no headings", () => {
    const content = "Just a plain paragraph with no headings at all.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 1000);
    // No headings → empty outline, all budget goes to body
    expect(result).toContain("Body:");
  });

  test("body does not duplicate outline content", () => {
    const content =
      "# Title\nFirst paragraph.\n\n## Section\nSecond paragraph.\n\nExtra content beyond the outline.";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 50);
    // Body should not start with the same tokens as the outline
    const bodyMatch = result.match(/Body:\s*(.*)/s);
    expect(bodyMatch).not.toBeNull();
    const bodyText = bodyMatch?.[1] ?? "";
    // The outline includes "# Title" so body should not start with "#"
    expect(bodyText.trimStart().startsWith("#")).toBe(false);
  });

  test("body does not repeat a paragraph pulled into the outline past a blank line", () => {
    // Blank line adds a \n token to the original but nothing to the outline.
    // Buggy offset (outline-token-count) undershoots, causing "word" — which
    // is already in the outline as the first paragraph — to reappear in body.
    const content = "# H\n\nword";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 5);
    const wordOccurrences = (result.match(/\bword\b/g) ?? []).length;
    expect(wordOccurrences).toBe(1);
  });

  test("omits body when remaining tokens render as empty after joinTokens", () => {
    // Trailing blank lines leave \n tokens past the last consumed line.
    // bodyTokens.length > 0 is insufficient because joinTokens trims whitespace
    // to an empty string. Body section must be omitted in that case.
    const content = "# H\nword\n\n";
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 10);
    expect(result).not.toContain("Body:");
  });

  test("body captures content after a truncated first paragraph", () => {
    // 31-word paragraph triggers the "..." suffix (3 extra tokens in outline).
    // Buggy offset overshoots the original stream and skips FINALWORD; fix
    // advances by source lines consumed, so body begins at FINALWORD.
    const paragraph = Array.from({ length: 31 }, (_, i) => `W${i + 1}`).join(
      " ",
    );
    const content = `# H\n${paragraph}\nFINALWORD`;
    const tokens = splitIntoTokens(content);
    const result = truncateHeading(content, tokens, 40);
    expect(result).toContain("Body:");
    expect(result).toContain("FINALWORD");
  });
});

describe("getContent", () => {
  function makeVaultApp(content: string) {
    return {
      vault: { read: async () => content },
    } as unknown as App;
  }

  test("returns full content when limit is 0", async () => {
    const content = "Hello world, this is some content.";
    const app = makeVaultApp(content);
    const result = await getContent(app, {} as TFile, 0);
    expect(result).toBe(content);
  });

  test("returns full content when limit is negative", async () => {
    const content = "Hello world, this is some content.";
    const app = makeVaultApp(content);
    const result = await getContent(app, {} as TFile, -1);
    expect(result).toBe(content);
  });
});
