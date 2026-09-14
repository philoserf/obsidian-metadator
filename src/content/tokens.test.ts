import { describe, expect, test } from "bun:test";
import { buildTokenRegex, sliceTokens, tokenize } from "./tokens";

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
