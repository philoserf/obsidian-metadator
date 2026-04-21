import Anthropic from "@anthropic-ai/sdk";
import { type App, Notice, type TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";
import { callClaude, getContent, updateFrontMatter } from "./utils";

function notifyApiError(error: unknown): void {
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
    new Notice(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      8000,
    );
  }
}

export interface MetadataResponse {
  tags?: string;
  description?: string;
  title?: string;
}

export interface PromptParts {
  system: string;
  userMessage: string;
}

export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): PromptParts {
  const systemParts = [
    "Generate metadata for the provided article. Requirements:",
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
    systemParts.push("", `3. Title: ${settings.titlePrompt}`);
    jsonFields.push('"title": "article title"');
  }

  systemParts.push(
    "",
    "Return only the following JSON format:",
    `{`,
    `    ${jsonFields.join(",\n    ")}`,
    `}`,
  );

  const userMessage = `<article>\n${contentStr}\n</article>`;

  return { system: systemParts.join("\n"), userMessage };
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
  const result = tryParseFromText(response);
  if (result) return result;

  // Fall back to extracting from code fences
  const fenceMatch = response.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return tryParseFromText(fenceMatch[1]);
  }

  return null;
}

function tryParseFromText(text: string): MetadataResponse | null {
  // Collect all valid candidates, prefer the last one (LLMs put the answer last)
  let best: MetadataResponse | null = null;
  for (const m of text.matchAll(/{[\s\S]*?}/g)) {
    try {
      const parsed: unknown = JSON.parse(m[0]);
      if (isValidMetadataResponse(parsed)) best = parsed;
    } catch {
      // not valid JSON, try next match
    }
  }
  if (best) return best;
  // Fall back to greedy match in case the valid JSON contains nested braces
  const greedy = text.match(/{[\s\S]*}/);
  if (greedy) {
    try {
      const parsed: unknown = JSON.parse(greedy[0]);
      if (isValidMetadataResponse(parsed)) return parsed;
    } catch {
      // not valid JSON
    }
  }
  return null;
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
  return isEmptyValue(currentValue) ? "update" : "keep";
}

export function shouldGenerate(
  frontMatter: Record<string, unknown>,
  settings: MetadataToolSettings,
): boolean {
  if (settings.updateMethod === "always_regenerate") return true;
  return (
    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    (settings.enableTitle && isEmptyValue(frontMatter[settings.titleFieldName]))
  );
}

export type FileResult =
  | { kind: "changed"; file: TFile }
  | { kind: "skipped"; file: TFile; reason: string }
  | { kind: "error"; file: TFile; reason: string; error: unknown };

export interface GenerateOptions {
  isBulk?: boolean;
}

export async function generateMetadataForFile(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  opts: GenerateOptions = {},
): Promise<FileResult> {
  if (file.extension !== "md") {
    return { kind: "skipped", file, reason: "not a markdown file" };
  }

  if (!settings.anthropicApiKey) {
    return { kind: "skipped", file, reason: "missing API key" };
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};

  if (!shouldGenerate(frontMatter, settings)) {
    return { kind: "skipped", file, reason: "all fields already populated" };
  }

  try {
    const updateAll = settings.updateMethod === "always_regenerate";
    const hasChanges = await addMetadataWithClaude(
      app,
      file,
      settings,
      frontMatter,
      updateAll,
      opts.isBulk ?? false,
    );
    return hasChanges
      ? { kind: "changed", file }
      : { kind: "skipped", file, reason: "no changes" };
  } catch (error) {
    return {
      kind: "error",
      file,
      reason: error instanceof Error ? error.message : String(error),
      error,
    };
  }
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

  if (!settings.anthropicApiKey) {
    new Notice(
      "Please configure your Anthropic API key in Settings → Metadator",
      8000,
    );
    return;
  }

  const result = await generateMetadataForFile(app, file, settings);
  if (result.kind === "changed") {
    new Notice("Metadata updated successfully");
  } else if (result.kind === "error") {
    notifyApiError(result.error);
    console.error("generateMetadata error:", result.error);
  }
}

async function addMetadataWithClaude(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  force: boolean = false,
  isBulk: boolean = false,
): Promise<boolean> {
  const contentStr = settings.truncateContent
    ? await getContent(
        app,
        file,
        settings.contentTokenLimit,
        settings.truncateMethod,
      )
    : await getContent(app, file, -1, "head_only");

  const { system, userMessage } = buildPrompt(contentStr, settings);

  if (settings.debugLogging && !isBulk) {
    console.log("[Metadator] System:", system);
    console.log("[Metadator] User message:", userMessage);
  }

  const notice = isBulk ? undefined : new Notice("Generating metadata...", 0);
  let response: string;
  try {
    response = await callClaude(system, userMessage, settings);
  } finally {
    notice?.hide();
  }

  if (settings.debugLogging) {
    if (isBulk) {
      console.log(
        `[Metadator] [bulk] ${file.path} — response ${response.length} chars`,
      );
    } else {
      console.log("[Metadator] Response:", response);
    }
  }

  if (!response) {
    return false;
  }

  const metadata: MetadataResponse = parseMetadataResponse(response) ?? {};

  let hasChanges = false;

  type FieldUpdate =
    | { fieldName: string; value: string[]; updateMethod: "append" }
    | { fieldName: string; value: string; updateMethod: "update" };

  async function writeField(
    u: FieldUpdate,
    resolved: "update" | "keep",
  ): Promise<boolean> {
    try {
      if (resolved === "keep") {
        return await updateFrontMatter(app, file, u.fieldName, u.value, "keep");
      }
      if (u.updateMethod === "append") {
        return await updateFrontMatter(
          app,
          file,
          u.fieldName,
          u.value,
          "append",
        );
      }
      return await updateFrontMatter(app, file, u.fieldName, u.value, "update");
    } catch (error) {
      if (!isBulk) {
        new Notice(
          `Failed to write ${u.fieldName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.error(`updateFrontMatter error (${u.fieldName}):`, error);
      return false;
    }
  }

  const updates: FieldUpdate[] = [];

  if (metadata.tags) {
    updates.push({
      fieldName: settings.tagsFieldName,
      value: parseTags(metadata.tags),
      updateMethod: "append",
    });
  }
  if (metadata.description) {
    updates.push({
      fieldName: settings.descriptionFieldName,
      value: metadata.description,
      updateMethod: "update",
    });
  }
  if (settings.enableTitle && metadata.title) {
    updates.push({
      fieldName: settings.titleFieldName,
      value: stripSurroundingQuotes(metadata.title),
      updateMethod: "update",
    });
  }

  for (const u of updates) {
    const resolved = resolveUpdateMethod(force, frontMatter[u.fieldName]);
    if (await writeField(u, resolved)) {
      hasChanges = true;
    }
  }

  return hasChanges;
}
