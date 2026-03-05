import { type App, Notice, type TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";
import { callClaude, getContent, updateFrontMatter } from "./utils";

export interface MetadataResponse {
  tags?: string;
  description?: string;
  title?: string;
}

export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): string {
  const promptParts = [
    "I need to generate metadata for the following article. Requirements:",
    "",
    `1. Tags: ${settings.tagsPrompt}`,
    "",
    `2. Description: ${settings.descriptionPrompt}`,
  ];

  const jsonFields: string[] = [
    '"tags": "tag1,tag2,tag3"',
    '"description": "brief summary"',
  ];

  if (settings.enableTitle) {
    promptParts.push("", `3. Title: ${settings.titlePrompt}`);
    jsonFields.push('"title": "article title"');
  }

  promptParts.push(
    "",
    "Please return in the following JSON format:",
    `{`,
    `    ${jsonFields.join(",\n    ")}`,
    `}`,
    "",
    "Article content:",
    "",
    contentStr,
  );

  return promptParts.join("\n");
}

function isValidMetadataResponse(obj: unknown): obj is MetadataResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    (r.tags === undefined || typeof r.tags === "string") &&
    (r.description === undefined || typeof r.description === "string") &&
    (r.title === undefined || typeof r.title === "string")
  );
}

export function parseMetadataResponse(
  response: string,
): MetadataResponse | null {
  const stripped = response.replace(/```(?:json)?\n?/g, "");
  const jsonMatch = stripped.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return null;
  }
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  return isValidMetadataResponse(parsed) ? parsed : null;
}

export function parseTags(tagsString: string): string[] {
  return tagsString
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export function stripSurroundingQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.substring(1, trimmed.length - 1);
  }
  return trimmed;
}

export function isEmptyValue(value: unknown): boolean {
  if (!value) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((v) => String(v).trim() === "");
  }
  return false;
}

export function resolveUpdateMethod(
  force: boolean,
  currentValue: unknown,
): "update" | "keep" {
  if (force) return "update";
  if (
    !currentValue ||
    (typeof currentValue === "string" && currentValue.trim() === "")
  ) {
    return "update";
  }
  return "keep";
}

export async function generateMetadata(
  app: App,
  settings: MetadataToolSettings,
): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Please open a file first");
    return;
  }

  if (file.extension !== "md") {
    new Notice("Current file is not a markdown file");
    return;
  }

  // Check if API key is configured
  if (!settings.anthropicApiKey || settings.anthropicApiKey === "") {
    new Notice(
      "Please configure your Anthropic API key in Settings → Metadator",
      8000,
    );
    return;
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};

  const updateAll = settings.updateMethod === "always_regenerate";

  // Check if we need to call Claude for metadata
  const needsMetadata =
    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    (settings.enableTitle &&
      isEmptyValue(frontMatter[settings.titleFieldName])) ||
    updateAll;

  if (needsMetadata) {
    try {
      const hasChanges = await addMetadataWithClaude(
        file,
        app,
        settings,
        frontMatter,
        updateAll,
      );
      if (hasChanges) {
        new Notice("Metadata updated successfully");
      }
    } catch (error) {
      // callClaude already shows a Notice for API errors and re-throws.
      // Surface unexpected errors that aren't from the API call.
      if (!(error instanceof Error && error.message.includes("API"))) {
        new Notice(
          `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          8000,
        );
      }
      console.error("generateMetadata error:", error);
    }
  }
}

async function addMetadataWithClaude(
  file: TFile,
  app: App,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  force: boolean = false,
): Promise<boolean> {
  let contentStr = "";
  if (settings.truncateContent) {
    contentStr = await getContent(
      app,
      file,
      settings.maxTokens,
      settings.truncateMethod,
    );
  } else {
    contentStr = await getContent(app, file, -1, "head_only");
  }

  const prompt = buildPrompt(contentStr, settings);

  let response: string;
  try {
    response = await callClaude(prompt, settings);
  } catch (error) {
    console.error("Error calling Claude:", error);
    return false;
  }

  if (!response) {
    return false;
  }

  let metadata: MetadataResponse = {};
  try {
    metadata = parseMetadataResponse(response) ?? {};
  } catch (error) {
    new Notice(
      `Error parsing response: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Parse error:", error);
    return false;
  }

  let hasChanges = false;

  // Update tags
  if (metadata.tags) {
    const tags = parseTags(metadata.tags);
    try {
      await updateFrontMatter(
        file,
        app,
        settings.tagsFieldName,
        tags,
        "append",
      );
      hasChanges = true;
    } catch (error) {
      new Notice(
        `Failed to write tags: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (tags):", error);
    }
  }

  // Update description
  if (metadata.description) {
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.descriptionFieldName],
    );
    try {
      await updateFrontMatter(
        file,
        app,
        settings.descriptionFieldName,
        metadata.description,
        method,
      );
      if (method === "update") {
        hasChanges = true;
      }
    } catch (error) {
      new Notice(
        `Failed to write description: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (description):", error);
    }
  }

  // Update title
  if (settings.enableTitle && metadata.title) {
    const title = stripSurroundingQuotes(metadata.title);
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.titleFieldName],
    );
    try {
      await updateFrontMatter(
        file,
        app,
        settings.titleFieldName,
        title,
        method,
      );
      if (method === "update") {
        hasChanges = true;
      }
    } catch (error) {
      new Notice(
        `Failed to write title: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (title):", error);
    }
  }

  return hasChanges;
}
