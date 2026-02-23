import { type App, Notice, type TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";
import { callClaude, getContent, updateFrontMatter } from "./utils";

interface MetadataResponse {
  tags?: string;
  description?: string;
  title?: string;
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
    } catch (error) {
      console.error("Error generating metadata with Claude:", error);
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

  const prompt = promptParts.join("\n");

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

  // Strip markdown code fences without removing backticks inside values
  response = response.replace(/```(?:json)?\n?/g, "");

  let metadata: MetadataResponse = {};
  try {
    const jsonMatch = response.match(/{[\s\S]*?}/);
    if (jsonMatch) {
      metadata = JSON.parse(jsonMatch[0]) as MetadataResponse;
    }
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
    const tags = metadata.tags.split(",").map((tag) => tag.trim());
    await updateFrontMatter(file, app, settings.tagsFieldName, tags, "append");
    hasChanges = true;
  }

  // Update description
  if (metadata.description) {
    const currentValue = frontMatter[settings.descriptionFieldName];
    const isEmpty =
      !currentValue ||
      (typeof currentValue === "string" && currentValue.trim() === "");
    const method = force || isEmpty ? "update" : "keep";
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
    let title = metadata.title.trim();
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.substring(1, title.length - 1);
    }
    const currentValue = frontMatter[settings.titleFieldName];
    const isEmpty =
      !currentValue ||
      (typeof currentValue === "string" && currentValue.trim() === "");
    const method = force || isEmpty ? "update" : "keep";
    await updateFrontMatter(file, app, settings.titleFieldName, title, method);
    if (method === "update") {
      hasChanges = true;
    }
  }

  return hasChanges;
}
