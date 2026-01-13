import Anthropic from "@anthropic-ai/sdk";
import {
  type App,
  getAllTags,
  MarkdownView,
  Notice,
  type TFile,
} from "obsidian";
import type { MetadataToolSettings } from "./settings";

export async function callClaude(
  prompt: string,
  settings: MetadataToolSettings,
): Promise<string> {
  const notice = new Notice("Generating metadata with Claude...", 0);

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

    // Provide user-friendly error messages
    if (error instanceof Error) {
      if (error.message.includes("authentication_error")) {
        new Notice(
          "Authentication failed. Please check your API key in Settings → Metadata Tool",
          8000,
        );
      } else if (error.message.includes("rate_limit")) {
        new Notice(
          "Rate limit exceeded. Please wait a moment and try again.",
          8000,
        );
      } else if (error.message.includes("overloaded")) {
        new Notice(
          "Claude API is currently overloaded. Please try again in a moment.",
          8000,
        );
      } else {
        new Notice(`Error calling Claude API: ${error.message}`, 8000);
      }
    } else {
      new Notice("An unknown error occurred while calling Claude API", 8000);
    }

    console.error("Claude API error:", error);
    throw error;
  }
}

function splitIntoTokens(str: string): string[] {
  // eslint-disable-next-line no-useless-escape
  const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g;
  const tokens = str.match(regex);
  return tokens || [];
}

function joinTokens(tokens: string[]): string {
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "\n") {
      result += token;
      // eslint-disable-next-line no-useless-escape
    } else if (/[\u4e00-\u9fa5]|[.,!?;，。！？；#]/.test(token)) {
      result += token;
    } else {
      result += (i > 0 ? " " : "") + token;
    }
  }
  return result.trim();
}

export async function getContent(
  app: App,
  file: TFile | null,
  limit: number = 1000,
  method: "head_only" | "head_tail" | "heading" = "head_only",
): Promise<string> {
  let contentStr = "";

  if (file !== null) {
    contentStr = await app.vault.read(file);
  } else {
    const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!editor) {
      return "";
    }
    contentStr = editor.getSelection();
    contentStr = contentStr.trim();
    if (contentStr.length === 0) {
      contentStr = editor.getValue();
    }
  }

  if (contentStr.length === 0) {
    return "";
  }

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit && limit > 0) {
    if (method === "head_tail") {
      const left = Math.round(limit * 0.8);
      const right = Math.round(limit * 0.2);
      const leftTokens = tokens.slice(0, left);
      const rightTokens = tokens.slice(-right);
      contentStr = `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
    } else if (method === "head_only") {
      contentStr = `${joinTokens(tokens.slice(0, limit))}...`;
    } else if (method === "heading") {
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
      contentStr = newLines.join("\n");
      const totalTokens = splitIntoTokens(contentStr);
      if (totalTokens.length > limit) {
        contentStr = joinTokens(totalTokens.slice(0, limit));
      } else {
        const remainingTokens = limit - totalTokens.length;
        const head = `${joinTokens(tokens.slice(0, remainingTokens))}...`;
        contentStr = `Outline: \n${contentStr}\n\nBody: ${head}`;
      }
    }
  }

  return contentStr;
}

export function updateFrontMatter(
  file: TFile,
  app: App,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): void {
  app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (value === undefined || value === null) {
      return;
    }

    if (method === "append") {
      let oldValue = frontmatter[key];
      if (typeof value === "string") {
        if (oldValue === undefined) {
          oldValue = "";
        }
        frontmatter[key] = oldValue + value;
      } else if (Array.isArray(value)) {
        if (oldValue === undefined) {
          oldValue = [];
        }
        const newValue = oldValue.concat(value);
        const uniqueValue = Array.from(new Set(newValue));
        frontmatter[key] = uniqueValue;
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

export async function loadTags(app: App): Promise<Record<string, number>> {
  const tagsMap: Record<string, number> = {};
  app.vault.getMarkdownFiles().forEach((file: TFile) => {
    const cachedMetadata = app.metadataCache.getFileCache(file);
    if (cachedMetadata) {
      const tags = getAllTags(cachedMetadata);
      if (tags) {
        tags.forEach((tag) => {
          let tagName = tag;
          if (tagName.startsWith("#")) {
            tagName = tagName.slice(1);
          }
          if (tagsMap[tagName]) {
            tagsMap[tagName]++;
          } else {
            tagsMap[tagName] = 1;
          }
        });
      }
    }
  });
  return tagsMap;
}

export function formatDate(date: Date, format: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return format
    .replace("YYYY", year.toString())
    .replace("MM", month)
    .replace("DD", day)
    .replace("HH", hours)
    .replace("mm", minutes)
    .replace("ss", seconds);
}
