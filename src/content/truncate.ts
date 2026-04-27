import { joinTokens, splitIntoTokens } from "./tokens";

export function truncateHeadOnly(tokens: string[], limit: number): string {
  const truncated = tokens.slice(0, limit);
  const suffix = truncated.length < tokens.length ? "..." : "";
  return `${joinTokens(truncated)}${suffix}`;
}

export function truncateHeadTail(tokens: string[], limit: number): string {
  if (limit >= tokens.length) {
    return joinTokens(tokens);
  }
  const left = Math.max(1, Math.floor(limit * 0.8));
  const right = Math.max(0, limit - left);
  const leftTokens = tokens.slice(0, left);
  if (right <= 0) {
    return joinTokens(leftTokens);
  }
  const rightTokens = tokens.slice(-right);
  return `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
}

export function truncateHeading(
  contentStr: string,
  tokens: string[],
  limit: number,
): string {
  const rawLines = contentStr.split("\n");
  const newLines: string[] = [];
  let captureNextParagraph = false;
  let tokenCursor = 0;
  // Exclusive index into `tokens` just past the last line the outline consumed.
  // Used as the body start so body never overlaps or misaligns with the
  // reconstructed outline's own token count.
  let bodyStart = 0;

  for (const line of rawLines) {
    const lineTokens = splitIntoTokens(line);
    const nextCursor = tokenCursor + lineTokens.length + 1;

    if (line.startsWith("#")) {
      newLines.push(line);
      captureNextParagraph = true;
      bodyStart = nextCursor;
    } else if (captureNextParagraph && line.trim() !== "") {
      const truncated = lineTokens.slice(0, 30);
      const suffix = truncated.length < lineTokens.length ? "..." : "";
      newLines.push(`${joinTokens(truncated)}${suffix}`);
      captureNextParagraph = false;
      bodyStart = nextCursor;
    }

    tokenCursor = nextCursor;
  }

  const result = newLines.join("\n");
  const outlineTokens = splitIntoTokens(result);
  if (outlineTokens.length > limit) {
    return joinTokens(outlineTokens.slice(0, limit));
  }

  const remainingTokens = limit - outlineTokens.length;
  const bodyTokens = tokens.slice(bodyStart, bodyStart + remainingTokens);
  const bodyText = joinTokens(bodyTokens);
  if (bodyText !== "") {
    const suffix = bodyStart + remainingTokens < tokens.length ? "..." : "";
    return `Outline: \n${result}\n\nBody: ${bodyText}${suffix}`;
  }
  return `Outline: \n${result}`;
}
