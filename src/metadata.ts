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

export function parseMetadataResponse(
  response: string,
): MetadataResponse | null {
  const stripped = response.replace(/```(?:json)?\n?/g, "");
  const jsonMatch = stripped.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return null;
  }
  return JSON.parse(jsonMatch[0]) as MetadataResponse;
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
    !frontMatter[settings.tagsFieldName] ||
    frontMatter[settings.tagsFieldName]?.length === 0 ||
    !frontMatter[settings.descriptionFieldName] ||
    frontMatter[settings.descriptionFieldName]?.trim() === "" ||
    (settings.enableTitle &&
      (!frontMatter[settings.titleFieldName] ||
        frontMatter[settings.titleFieldName]?.trim() === "")) ||
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
    } catch {
      // Error already logged and shown to user by callClaude
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
    await updateFrontMatter(file, app, settings.tagsFieldName, tags, "append");
    hasChanges = true;
  }

  // Update description
  if (metadata.description) {
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.descriptionFieldName],
    );
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
  }

  // Update title
  if (settings.enableTitle && metadata.title) {
    const title = stripSurroundingQuotes(metadata.title);
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.titleFieldName],
    );
    await updateFrontMatter(file, app, settings.titleFieldName, title, method);
    if (method === "update") {
      hasChanges = true;
    }
  }

  return hasChanges;
}
