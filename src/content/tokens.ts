// CJK ideographs, hiragana/katakana, and hangul syllables are tokenized
// per-character to approximate how LLM tokenizers count them; everything
// else (Latin, Cyrillic, Greek, Hebrew, Arabic, Devanagari, Thai, ...)
// is tokenized as whole words via the Unicode letter/number classes, with
// CJK-family ranges subtracted so the greedy word match stops at script
// boundaries. Words must start with Letter or Number — \p{Mark} is allowed
// only as a trailing char so a standalone combining mark (e.g. emoji
// variation selector U+FE0F) never becomes a token of its own.
//
// The v-flag set-subtraction syntax requires Chromium 112+/Safari 17+. The
// constructor is wrapped in try/catch so older mobile WebViews fall back
// to a u-flag regex (loses CJK-Latin boundary handling but the plugin
// still loads and non-CJK scripts still tokenize correctly).
const CJK_FAMILY_RANGES = "一-龥぀-ヿ가-힯";

function buildTokenRegex(): RegExp {
  try {
    return new RegExp(
      `[一-龥]|[぀-ヿ]|[가-힯]|[[\\p{Letter}\\p{Number}]--[${CJK_FAMILY_RANGES}]][[\\p{Letter}\\p{Mark}\\p{Number}]--[${CJK_FAMILY_RANGES}]]*|[.,!?;，。！？；#]|\\n`,
      "gv",
    );
  } catch {
    return /[一-龥]|[぀-ヿ]|[가-힯]|[\p{Letter}\p{Number}][\p{Letter}\p{Mark}\p{Number}]*|[.,!?;，。！？；#]|\n/gu;
  }
}

const TOKEN_REGEX = buildTokenRegex();
const NON_SPACING_TOKEN = /^[一-龥぀-ヿ가-힯.,!?;，。！？；#]$/;

export function splitIntoTokens(str: string): string[] {
  return str.match(TOKEN_REGEX) ?? [];
}

export function joinTokens(tokens: string[]): string {
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "\n") {
      result += token;
    } else if (NON_SPACING_TOKEN.test(token)) {
      result += token;
    } else {
      const prevToken = i > 0 ? tokens[i - 1] : undefined;
      const needsSpace = i > 0 && prevToken !== "\n";
      result += (needsSpace ? " " : "") + token;
    }
  }
  return result.trim();
}
