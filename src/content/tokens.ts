// CJK ideographs, hiragana/katakana, and hangul syllables are tokenized
// per-character to approximate how LLM tokenizers count them; everything
// else (Latin, Cyrillic, Greek, Hebrew, Arabic, Devanagari, Thai, ...)
// is tokenized as whole words via the Unicode letter/number classes, with
// CJK-family ranges subtracted so the greedy word match stops at script
// boundaries. Words must start with Letter or Number — \p{Mark} is allowed
// only as a trailing char so a combining mark never joins the word ahead of it.
//
// The trailing `\S` catch-all is what keeps the count honest: without it,
// emoji and every markdown symbol (* _ ` [ ] ( ) - : | ...) matched no
// alternative and vanished from the count, so a note's real cost was badly
// undercounted (#179). Whitespace other than `\n` is still uncounted, which
// matches how real BPE tokenizers absorb spaces into the following word.
//
// The v-flag set-subtraction syntax requires Chromium 112+/Safari 17+. The
// constructor is wrapped in try/catch so older mobile WebViews fall back
// to a u-flag regex (loses CJK-Latin boundary handling but the plugin
// still loads and non-CJK scripts still tokenize correctly).
const CJK_FAMILY_RANGES = "一-龥぀-ヿ가-힯";

function buildTokenRegex(): RegExp {
  try {
    return new RegExp(
      `[一-龥]|[぀-ヿ]|[가-힯]|[[\\p{Letter}\\p{Number}]--[${CJK_FAMILY_RANGES}]][[\\p{Letter}\\p{Mark}\\p{Number}]--[${CJK_FAMILY_RANGES}]]*|[.,!?;，。！？；#]|\\n|\\S`,
      "gv",
    );
  } catch {
    return /[一-龥]|[぀-ヿ]|[가-힯]|[\p{Letter}\p{Number}][\p{Letter}\p{Mark}\p{Number}]*|[.,!?;，。！？；#]|\n|\S/gu;
  }
}

const TOKEN_REGEX = buildTokenRegex();

// A token plus where it came from. The offsets are what let truncation rebuild
// its output by slicing the source string instead of re-joining token text —
// re-joining drops or re-spaces everything the counting regex treats as a
// single character (#182).
export interface Token {
  text: string;
  start: number;
  end: number;
}

export function tokenize(str: string): Token[] {
  const out: Token[] = [];
  for (const m of str.matchAll(TOKEN_REGEX)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// The source text spanned by a run of tokens, including whatever whitespace and
// unmatched characters sit between them. Empty for an empty run.
export function sliceTokens(source: string, tokens: Token[]): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!first || !last) return "";
  return source.slice(first.start, last.end);
}

export function splitIntoTokens(str: string): string[] {
  return tokenize(str).map((t) => t.text);
}
