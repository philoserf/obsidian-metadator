import { sliceTokens, type Token, tokenize } from "./tokens";

// Named for the three strategies implemented below.
export type TruncateMethod = "head_only" | "head_tail" | "heading";

export function truncateHeadOnly(
  source: string,
  tokens: Token[],
  limit: number,
): string {
  const truncated = tokens.slice(0, limit);
  const suffix = truncated.length < tokens.length ? "..." : "";
  return `${sliceTokens(source, truncated)}${suffix}`;
}

export function truncateHeadTail(
  source: string,
  tokens: Token[],
  limit: number,
): string {
  if (limit >= tokens.length) {
    return sliceTokens(source, tokens);
  }
  const left = Math.max(1, Math.floor(limit * 0.8));
  const right = Math.max(0, limit - left);
  const leftTokens = tokens.slice(0, left);
  if (right <= 0) {
    return sliceTokens(source, leftTokens);
  }
  const rightTokens = tokens.slice(-right);
  return `${sliceTokens(source, leftTokens)}\n...\n${sliceTokens(source, rightTokens)}`;
}

// One line of the source plus the slice of the already-computed token array
// that covers it. Building this once removes the per-line tokenize() calls and
// the separate pass over the assembled outline (#181), and gives the heading
// walk somewhere to hang line state.
interface LineInfo {
  text: string;
  tokenStart: number;
  tokenEnd: number;
}

// Both the lines and the tokens are in source order, so one forward walk pairs
// them up. Newline tokens land in whichever line they terminate, which is why
// the old manual "+1 for the newline" cursor arithmetic is gone rather than
// carried over — a line's tokenEnd is now simply where the next line starts.
function indexLines(source: string, tokens: Token[]): LineInfo[] {
  const lines: LineInfo[] = [];
  let cursor = 0;
  let t = 0;
  for (const text of source.split("\n")) {
    const lineEnd = cursor + text.length;
    const tokenStart = t;
    while (t < tokens.length && tokens[t].start < lineEnd) t++;
    // The newline itself terminates this line.
    if (
      t < tokens.length &&
      tokens[t].text === "\n" &&
      tokens[t].start === lineEnd
    ) {
      t++;
    }
    lines.push({ text, tokenStart, tokenEnd: t });
    cursor = lineEnd + 1;
  }
  return lines;
}

const PARAGRAPH_TOKEN_CAP = 30;

export function truncateHeading(
  contentStr: string,
  tokens: Token[],
  limit: number,
): string {
  const lines = indexLines(contentStr, tokens);
  const newLines: string[] = [];
  let captureNextParagraph = false;
  // Exclusive index into `tokens` just past the last line the outline consumed,
  // so the body never overlaps the reconstructed outline.
  let bodyStart = 0;

  for (const line of lines) {
    if (line.text.startsWith("#")) {
      newLines.push(line.text);
      captureNextParagraph = true;
      bodyStart = line.tokenEnd;
    } else if (captureNextParagraph && line.text.trim() !== "") {
      const lineTokens = tokens.slice(line.tokenStart, line.tokenEnd);
      const truncated = lineTokens.slice(0, PARAGRAPH_TOKEN_CAP);
      const suffix = truncated.length < lineTokens.length ? "..." : "";
      newLines.push(`${sliceTokens(contentStr, truncated)}${suffix}`);
      captureNextParagraph = false;
      bodyStart = line.tokenEnd;
    }
  }

  const result = newLines.join("\n");
  // The outline is a constructed string — reordered lines, some with an
  // ellipsis appended — so its tokens are not a contiguous slice of `tokens`
  // and have to be counted directly. This is the one remaining pass, and it is
  // over the outline rather than the document; the two full-document passes
  // (per line, and again here) are what #181 removed.
  const outlineTokens = tokenize(result);
  if (outlineTokens.length > limit) {
    return sliceTokens(result, outlineTokens.slice(0, limit));
  }

  const remainingTokens = limit - outlineTokens.length;
  const bodyTokens = tokens.slice(bodyStart, bodyStart + remainingTokens);
  const bodyText = sliceTokens(contentStr, bodyTokens);
  // A run of nothing but newline tokens slices to whitespace; there is no body
  // worth showing in that case.
  if (bodyText.trim() !== "") {
    const suffix = bodyStart + remainingTokens < tokens.length ? "..." : "";
    return `Outline: \n${result}\n\nBody: ${bodyText}${suffix}`;
  }
  return `Outline: \n${result}`;
}
