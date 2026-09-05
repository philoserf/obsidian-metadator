import { describe, expect, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { getContent } from "./content/getContent";
import { buildTokenRegex, sliceTokens, tokenize } from "./content/tokens";
import {
  truncateHeading,
  truncateHeadOnly,
  truncateHeadTail,
} from "./content/truncate";

// Assertion helper: the tokenizer returns {text, start, end} spans, but these
// tests only care about the text. No production caller wants this shape.
const splitIntoTokens = (s: string) => tokenize(s).map((t) => t.text);

// Both regex builds must agree exactly. The v-flag build is what every current
// runtime takes; the u-flag fallback only runs on older mobile WebViews, so
// without forcing it here its lookahead-based CJK exclusion would never be
// exercised in CI — which is how #162's unbounded Latin+CJK merge survived.
for (const [label, regex] of [
  ["v-flag", buildTokenRegex()],
  ["u-flag fallback", buildTokenRegex(true)],
] as const) {
  describe(`splitIntoTokens (${label})`, () => {
    const splitIntoTokens = (s: string) =>
      tokenize(s, regex).map((t) => t.text);

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

    test("counts emoji and their variation selectors", () => {
      // U+2764 (heart) + U+FE0F (variation selector-16). Neither starts a word,
      // so both fall to the `\S` catch-all — they cost real tokens at the API
      // and must not vanish from the count (#179).
      expect(splitIntoTokens("❤️")).toEqual(["❤", "\uFE0F"]);
    });

    test("counts a leading combining mark without joining it to the word", () => {
      expect(splitIntoTokens("́abc")).toEqual(["\u0301", "abc"]);
    });

    test("counts markdown syntax characters", () => {
      expect(splitIntoTokens("**bold**")).toEqual(["*", "*", "bold", "*", "*"]);
    });

    test("still ignores spaces and tabs", () => {
      expect(splitIntoTokens("a \t b")).toEqual(["a", "b"]);
    });
  });
}

describe("tokenize / sliceTokens", () => {
  test("token offsets point back into the source", () => {
    const src = "hello world";
    const tokens = tokenize(src);
    expect(tokens.map((t) => src.slice(t.start, t.end))).toEqual([
      "hello",
      "world",
    ]);
  });

  test("sliceTokens returns the source span, whitespace and all", () => {
    const src = "Hello,   мир!";
    expect(sliceTokens(src, tokenize(src))).toBe(src);
  });

  test("sliceTokens preserves characters the counting regex sees one-by-one", () => {
    const src = "This is **bold** text";
    const tokens = tokenize(src);
    expect(sliceTokens(src, tokens.slice(0, 6))).toBe("This is **bold*");
  });

  test("sliceTokens returns empty string for an empty run", () => {
    expect(sliceTokens("anything", [])).toBe("");
  });
});

describe("truncateHeadOnly", () => {
  const src = "one two three four five";

  test("returns first N tokens with ellipsis", () => {
    expect(truncateHeadOnly(src, tokenize(src), 3)).toBe("one two three...");
  });

  test("handles limit of 1", () => {
    expect(truncateHeadOnly(src, tokenize(src), 1)).toBe("one...");
  });

  test("returns all tokens when limit equals length", () => {
    const short = "one two three";
    expect(truncateHeadOnly(short, tokenize(short), 3)).toBe("one two three");
  });

  test("returns all tokens when limit exceeds length", () => {
    const short = "one two";
    expect(truncateHeadOnly(short, tokenize(short), 10)).toBe("one two");
  });

  test("keeps markdown syntax inside the kept span (#182)", () => {
    // The exact string from #182. Before the fix this returned
    // "# Title\n\nThis is bold and..." — every emphasis, link, and code
    // marker inside the kept span was deleted, not merely uncounted.
    const md =
      "# Title\n\nThis is **bold** and _italic_ text with a [link](http://example.com) and `code`.";
    const out = truncateHeadOnly(md, tokenize(md), 15);
    expect(out).toBe("# Title\n\nThis is **bold** and _italic_...");
  });

  test("keeps emoji inside the kept span (#182)", () => {
    const md = "alpha 😀 beta gamma delta";
    expect(truncateHeadOnly(md, tokenize(md), 3)).toBe("alpha 😀 beta...");
  });
});

describe("truncateHeadTail", () => {
  test("returns full content when limit covers all tokens", () => {
    const src = Array.from({ length: 10 }, (_, i) => `t${i}`).join(" ");
    const result = truncateHeadTail(src, tokenize(src), 10);
    expect(result).toBe(src);
    expect(result).not.toContain("...");
  });

  test("returns full content when limit exceeds token count", () => {
    const src = "a b c";
    const result = truncateHeadTail(src, tokenize(src), 100);
    expect(result).toBe(src);
    expect(result).not.toContain("...");
  });

  test("handles small limit", () => {
    const src = "a b c d e f g h i j";
    const result = truncateHeadTail(src, tokenize(src), 5);
    // 80% of 5 = 4, 20% of 5 = 1
    expect(result).toContain("a");
    expect(result).toContain("\n...\n");
  });

  test("handles limit of 1", () => {
    const src = "a b c d e";
    const result = truncateHeadTail(src, tokenize(src), 1);
    // All budget goes to head, tail is empty — no separator
    expect(result).toBe("a");
    expect(result).not.toContain("\n...\n");
  });

  test("keeps markdown in both halves (#182)", () => {
    const src = "**start** one two three four five six _end_";
    // left = floor(7 * 0.8) = 5 tokens (* * start * *), right = 2 (end _).
    const result = truncateHeadTail(src, tokenize(src), 7);
    expect(result).toContain("**start**");
    expect(result).toContain("end_");
  });
});

describe("truncateHeading", () => {
  test("extracts headings and first paragraph", () => {
    const content =
      "# Title\nSome paragraph text here for testing.\n\n## Section\nMore text in section.";
    const tokens = tokenize(content);
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
    const tokens = tokenize(content);
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
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
  });

  test("does not append ellipsis to short paragraphs", () => {
    const content = "# Title\nShort paragraph.";
    const tokens = tokenize(content);
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
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 4);
    expect(result).toContain("Outline:");
    expect(result).not.toContain("Body:");
  });

  test("handles content with no headings", () => {
    const content = "Just a plain paragraph with no headings at all.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    // No headings → empty outline, all budget goes to body
    expect(result).toContain("Body:");
  });

  test("body does not duplicate outline content", () => {
    const content =
      "# Title\nFirst paragraph.\n\n## Section\nSecond paragraph.\n\nExtra content beyond the outline.";
    const tokens = tokenize(content);
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
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 5);
    const wordOccurrences = (result.match(/\bword\b/g) ?? []).length;
    expect(wordOccurrences).toBe(1);
  });

  test("omits body when remaining tokens render as empty after joinTokens", () => {
    // Trailing blank lines leave \n tokens past the last consumed line.
    // bodyTokens.length > 0 is insufficient because joinTokens trims whitespace
    // to an empty string. Body section must be omitted in that case.
    const content = "# H\nword\n\n";
    const tokens = tokenize(content);
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
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 40);
    expect(result).toContain("Body:");
    expect(result).toContain("FINALWORD");
  });
});

describe("getContent", () => {
  function makeVaultApp(content: string) {
    return {
      vault: { read: async () => content, cachedRead: async () => content },
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
