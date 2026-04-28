// CJK ideographs, hiragana/katakana, and hangul syllables are tokenized
// per-character to approximate how LLM tokenizers count them; everything
// else (Latin, Cyrillic, Greek, Hebrew, Arabic, Devanagari, Thai, ...)
// is tokenized as whole words via the Unicode letter/mark/number classes,
// with CJK-family ranges subtracted so the greedy word match stops at
// script boundaries.
const TOKEN_REGEX =
  /[一-龥]|[぀-ヿ]|[가-힯]|[[\p{Letter}\p{Mark}\p{Number}]--[一-龥぀-ヿ가-힯]]+|[.,!?;，。！？；#]|\n/gv;
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
