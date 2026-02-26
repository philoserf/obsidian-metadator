import Anthropic from "@anthropic-ai/sdk";
import { type App, Notice, type TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";

export async function callClaude(
  prompt: string,
  settings: MetadataToolSettings,
): Promise<string> {
  const notice = new Notice("Generating metadata...", 0);

  // Safe in Obsidian's Electron renderer — no browser security concerns apply
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  try {
    const message = await anthropic.messages.create({
      model: settings.anthropicModel,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    notice.hide();

    if (message.content.length > 0 && message.content[0].type === "text") {
      return message.content[0].text;
    }

    throw new Error("No text content in response");
  } catch (error) {
    notice.hide();

    if (error instanceof Anthropic.AuthenticationError) {
      new Notice(
        "Authentication failed. Please check your API key in Settings → Metadator",
        8000,
      );
    } else if (error instanceof Anthropic.RateLimitError) {
      new Notice(
        "Rate limit exceeded. Please wait a moment and try again.",
        8000,
      );
    } else if (error instanceof Anthropic.InternalServerError) {
      new Notice(
        "API is currently overloaded. Please try again in a moment.",
        8000,
      );
    } else if (error instanceof Anthropic.APIError) {
      new Notice(`API error: ${error.message}`, 8000);
    } else {
      new Notice("An unknown API error occurred", 8000);
    }

    console.error("Claude API error:", error);
    throw error;
  }
}

export function splitIntoTokens(str: string): string[] {
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
  return `${joinTokens(tokens.slice(0, limit))}...`;
}

export function truncateHeadTail(tokens: string[], limit: number): string {
  const left = Math.max(1, Math.floor(limit * 0.8));
  const right = Math.max(0, limit - left);
  const leftTokens = tokens.slice(0, left);
  const rightTokens = right > 0 ? tokens.slice(-right) : [];
  return `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
}

export function truncateHeading(
  contentStr: string,
  tokens: string[],
  limit: number,
): string {
  let lines = contentStr.split("\n");
  lines = lines.filter((line) => line.trim() !== "");

  const newLines: string[] = [];
  let captureNextParagraph = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      newLines.push(line);
      captureNextParagraph = true;
    } else if (captureNextParagraph && line.trim() !== "") {
      const lineTokens = splitIntoTokens(line);
      newLines.push(`${joinTokens(lineTokens.slice(0, 30))}...`);
      captureNextParagraph = false;
    }
  }
  let result = newLines.join("\n");
  const totalTokens = splitIntoTokens(result);
  if (totalTokens.length > limit) {
    result = joinTokens(totalTokens.slice(0, limit));
  } else {
    const remainingTokens = limit - totalTokens.length;
    const head = `${joinTokens(tokens.slice(0, remainingTokens))}...`;
    result = `Outline: \n${result}\n\nBody: ${head}`;
  }
  return result;
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

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit && limit > 0) {
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

export async function updateFrontMatter(
  file: TFile,
  app: App,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      if (Array.isArray(value)) {
        const existing = frontmatter[key];
        const base = Array.isArray(existing)
          ? existing
          : existing != null
            ? [String(existing)]
            : [];
        frontmatter[key] = Array.from(new Set(base.concat(value)));
      }
    } else if (method === "update") {
      frontmatter[key] = value;
    } else {
      const oldValue = frontmatter[key];
      if (oldValue !== undefined) {
        return;
      }
      frontmatter[key] = value;
    }
  });
}
