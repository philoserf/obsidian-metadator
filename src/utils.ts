import Anthropic from "@anthropic-ai/sdk";
import type { App, TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";

// Output budget for the model's JSON response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;

export interface CallClaudeOptions {
  signal?: AbortSignal;
}

export async function callClaude(
  system: string,
  userMessage: string,
  settings: MetadataToolSettings,
  options: CallClaudeOptions = {},
): Promise<string> {
  // Safe in Obsidian's Electron renderer — no browser security concerns apply
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  const message = await anthropic.messages.create(
    {
      model: settings.anthropicModel,
      max_tokens: MAX_RESPONSE_TOKENS,
      system,
      messages: [{ role: "user", content: userMessage }],
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      signal: options.signal,
    },
  );

  if (message.content.length > 0 && message.content[0].type === "text") {
    return message.content[0].text;
  }

  throw new Error("No text content in response");
}

export function splitIntoTokens(str: string): string[] {
  // CJK ideographs → one token each (they carry meaning per character)
  // Latin words/numbers → one token per word (whitespace-delimited)
  // Punctuation (ASCII + CJK) → individual tokens (preserves structure)
  // Newlines → tokens (headings and paragraphs depend on line breaks)
  const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g;
  const tokens = str.match(regex);
  return tokens || [];
}

export function joinTokens(tokens: string[]): string {
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "\n") {
      result += token;
    } else if (/[\u4e00-\u9fa5]|[.,!?;，。！？；#]/.test(token)) {
      result += token;
    } else {
      const prevToken = i > 0 ? tokens[i - 1] : undefined;
      const needsSpace = i > 0 && prevToken !== "\n";
      result += (needsSpace ? " " : "") + token;
    }
  }
  return result.trim();
}

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

export async function getContent(
  app: App,
  file: TFile,
  limit: number = 1000,
  method: "head_only" | "head_tail" | "heading" = "head_only",
): Promise<string> {
  let contentStr = await app.vault.read(file);

  if (contentStr.length === 0) {
    return "";
  }

  if (limit <= 0) {
    return contentStr;
  }

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit) {
    if (method === "head_tail") {
      contentStr = truncateHeadTail(tokens, limit);
    } else if (method === "head_only") {
      contentStr = truncateHeadOnly(tokens, limit);
    } else if (method === "heading") {
      contentStr = truncateHeading(contentStr, tokens, limit);
    }
  }

  return contentStr;
}

export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string[],
  method: "append",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean,
  method: "update",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "keep",
): Promise<boolean>;
export async function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): Promise<boolean> {
  let changed = false;
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      const values = value as string[];
      const existing = frontmatter[key];
      const base = Array.isArray(existing)
        ? existing
        : existing != null
          ? [String(existing)]
          : [];
      const merged = Array.from(new Set(base.concat(values)));
      changed =
        !Array.isArray(existing) ||
        base.length !== merged.length ||
        base.some((item, i) => item !== merged[i]);
      frontmatter[key] = merged;
    } else if (method === "update") {
      if (frontmatter[key] !== value) changed = true;
      frontmatter[key] = value;
    } else if (frontmatter[key] === undefined) {
      frontmatter[key] = value;
      changed = true;
    }
  });
  return changed;
}
