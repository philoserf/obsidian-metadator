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
      "Please configure your Anthropic API key in Settings → Metadata Tool",
      8000,
    );
    return;
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};
  let hasChanges = false;

  const force = settings.updateMethod === "force";

  // Check if we need to call Claude for metadata
  const needsMetadata =
    !frontMatter[settings.tagsFieldName] ||
    frontMatter[settings.tagsFieldName]?.length === 0 ||
    !frontMatter[settings.descriptionFieldName] ||
    frontMatter[settings.descriptionFieldName]?.trim() === "" ||
    (settings.enableTitle &&
      (!frontMatter[settings.titleFieldName] ||
        frontMatter[settings.titleFieldName]?.trim() === "")) ||
    force;

  console.log("Metadata generation check:", {
    needsMetadata,
    hasTags: !!frontMatter[settings.tagsFieldName],
    hasDescription: !!frontMatter[settings.descriptionFieldName],
    hasTitle: !!frontMatter[settings.titleFieldName],
    force,
  });

  if (needsMetadata) {
    try {
      await addMetadataWithClaude(file, app, settings, frontMatter, force);
      hasChanges = true;
    } catch (error) {
      console.error("Error generating metadata with Claude:", error);
      return;
    }
  }

  // Add custom metadata
  if (settings.customMetadata && settings.customMetadata.length > 0) {
    for (const meta of settings.customMetadata) {
      if (meta.key && meta.value) {
        let finalValue: string | boolean = meta.value;
        if (
          meta.value.toLowerCase() === "true" ||
          meta.value.toLowerCase() === "false"
        ) {
          finalValue = meta.value.toLowerCase() === "true";
        }
        updateFrontMatter(
          file,
          app,
          meta.key,
          finalValue,
          force ? "update" : "keep",
        );
      }
    }
    hasChanges = true;
  }

  if (hasChanges) {
    new Notice("Metadata updated successfully");
  }
}

async function addMetadataWithClaude(
  file: TFile,
  app: App,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  force: boolean = false,
): Promise<void> {
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

  console.log("Content extracted (length):", contentStr.length);
  console.log("Content preview:", contentStr.substring(0, 200));

  const prompt = `I need to generate tags, description, and title for the following article. Requirements:

1. Tags: ${settings.tagsPrompt}

2. Description: ${settings.descriptionPrompt}

3. Title: ${settings.titlePrompt}

Please return in the following JSON format:
{
    "tags": "tag1,tag2,tag3",
    "description": "brief summary",
    "title": "article title"
}

Article content:

${contentStr}`;

  let response: string;
  try {
    console.log("Calling Claude with prompt...");
    response = await callClaude(prompt, settings);
    console.log("Claude response received:", response);
  } catch (error) {
    console.error("Error calling Claude:", error);
    return;
  }

  if (!response) {
    console.log("No response from Claude");
    return;
  }

  // Clean up response
  response = response.replace(/`/g, "");

  let metadata: MetadataResponse = {};
  try {
    const jsonMatch = response.match(/{[\s\S]*}/);
    if (jsonMatch) {
      console.log("Found JSON in response:", jsonMatch[0]);
      metadata = JSON.parse(jsonMatch[0]) as MetadataResponse;
      console.log("Parsed metadata:", metadata);
    } else {
      console.log("No JSON found in response");
    }
  } catch (error) {
    new Notice(`Error parsing Claude response: ${error}`);
    console.error("Parse error:", error);
    return;
  }

  // Update tags
  if (metadata.tags) {
    console.log("Updating tags:", metadata.tags);
    const tags = metadata.tags.split(",").map((tag) => tag.trim());
    updateFrontMatter(file, app, settings.tagsFieldName, tags, "append");
  }

  // Update description
  if (metadata.description) {
    const currentValue = frontMatter[settings.descriptionFieldName];
    const isEmpty =
      !currentValue ||
      (typeof currentValue === "string" && currentValue.trim() === "");
    updateFrontMatter(
      file,
      app,
      settings.descriptionFieldName,
      metadata.description,
      force || isEmpty ? "update" : "keep",
    );
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
    updateFrontMatter(
      file,
      app,
      settings.titleFieldName,
      title,
      force || isEmpty ? "update" : "keep",
    );
  }
}
