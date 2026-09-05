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

export function truncateHeading(
  contentStr: string,
  tokens: Token[],
  limit: number,
): string {
  const rawLines = contentStr.split("\n");
  const newLines: string[] = [];
  let captureNextParagraph = false;
  let tokenCursor = 0;
  // Exclusive index into `tokens` just past the last line the outline consumed.
  // Used as the body start so body never overlaps or misaligns with the
  // reconstructed outline's own token count. The +1 accounts for the newline
  // token between lines; `\S` never matches a newline, so the catch-all above
  // leaves this arithmetic intact.
  let bodyStart = 0;

  for (const line of rawLines) {
    const lineTokens = tokenize(line);
    const nextCursor = tokenCursor + lineTokens.length + 1;

    if (line.startsWith("#")) {
      newLines.push(line);
      captureNextParagraph = true;
      bodyStart = nextCursor;
    } else if (captureNextParagraph && line.trim() !== "") {
      const truncated = lineTokens.slice(0, 30);
      const suffix = truncated.length < lineTokens.length ? "..." : "";
      newLines.push(`${sliceTokens(line, truncated)}${suffix}`);
      captureNextParagraph = false;
      bodyStart = nextCursor;
    }

    tokenCursor = nextCursor;
  }

  const result = newLines.join("\n");
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
