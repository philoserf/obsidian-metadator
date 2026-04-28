import { type App, Notice, type TFile } from "obsidian";
import {
  ClaudeApiError,
  callClaudeForMetadata,
  type MetadataFields,
} from "./adapters/claude";
import { updateFrontMatter } from "./adapters/frontmatter";
import { getContent } from "./content/getContent";
import type { MetadataToolSettings } from "./settings";

function notifyApiError(error: unknown): void {
  if (error instanceof ClaudeApiError) {
    switch (error.kind) {
      case "auth":
        new Notice(
          "Authentication failed. Please check your API key in Settings → Metadator",
          8000,
        );
        return;
      case "rate_limit":
        new Notice(
          "Rate limit exceeded. Please wait a moment and try again.",
          8000,
        );
        return;
      case "overloaded":
        new Notice(
          "API is currently overloaded. Please try again in a moment.",
          8000,
        );
        return;
      case "api":
        new Notice(`API error: ${error.message}`, 8000);
        return;
      case "unknown":
        new Notice(`Unexpected error: ${error.message}`, 8000);
        return;
    }
  }
  new Notice(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    8000,
  );
}

export type { MetadataFields } from "./adapters/claude";

export interface PromptParts {
  system: string;
  userMessage: string;
}

export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): PromptParts {
  const systemParts = [
    "Generate metadata for the provided article and submit it via the submit_metadata tool. Field requirements:",
    "",
    `1. Tags: ${settings.tagsPrompt}`,
    "",
    `2. Description: ${settings.descriptionPrompt}`,
  ];

  if (settings.enableTitle) {
    systemParts.push("", `3. Title: ${settings.titlePrompt}`);
  }

  const userMessage = `<article>\n${contentStr}\n</article>`;

  return { system: systemParts.join("\n"), userMessage };
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
  signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
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

  if (opts.signal?.aborted) {
    return { kind: "skipped", file, reason: "cancelled before request" };
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
      opts.signal,
    );
    return hasChanges
      ? { kind: "changed", file }
      : { kind: "skipped", file, reason: "no changes" };
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) {
      return { kind: "skipped", file, reason: "cancelled" };
    }
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
  opts: GenerateOptions = {},
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

  const result = await generateMetadataForFile(app, file, settings, {
    signal: opts.signal,
  });
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
  signal?: AbortSignal,
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
  let metadata: MetadataFields;
  try {
    metadata = await callClaudeForMetadata(system, userMessage, settings, {
      signal,
    });
  } finally {
    notice?.hide();
  }

  if (settings.debugLogging) {
    if (isBulk) {
      console.log(`[Metadator] [bulk] ${file.path} — fields received`);
    } else {
      console.log("[Metadator] Fields:", metadata);
    }
  }

  if (signal?.aborted) {
    return false;
  }

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
    if (signal?.aborted) {
      return hasChanges;
    }
    const resolved = resolveUpdateMethod(force, frontMatter[u.fieldName]);
    if (await writeField(u, resolved)) {
      hasChanges = true;
    }
  }

  return hasChanges;
}
