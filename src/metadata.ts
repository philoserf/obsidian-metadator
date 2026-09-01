import { type App, Notice, type TFile } from "obsidian";
import {
  ClaudeApiError,
  callClaudeForMetadata,
  type MetadataFields,
} from "./adapters/claude";
import { updateFrontMatter } from "./adapters/frontmatter";
import { getContent } from "./content/getContent";
import { isEmptyValue } from "./emptyValue";
import { logDebug, logError, newRequestId } from "./logger";
import { buildPrompt, parseTags } from "./prompt";
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
export { buildPrompt, type PromptParts, parseTags } from "./prompt";

function stripSurroundingQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.substring(1, trimmed.length - 1);
  }
  return trimmed;
}

export type WritePolicy = "update_all" | "only_empty";
export type PresentationMode = "interactive" | "bulk";

function writePolicyFromSettings(settings: MetadataToolSettings): WritePolicy {
  return settings.updateMethod === "always_regenerate"
    ? "update_all"
    : "only_empty";
}

function resolveUpdateMethod(
  policy: WritePolicy,
  currentValue: unknown,
): "update" | "keep" {
  if (policy === "update_all") return "update";
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

// What a write pass actually did. `failures` is what separates "every field
// was already populated" from "every write threw" — before this, both surfaced
// as `hasChanges === false` and the file was reported as skipped (#187).
interface WriteOutcome {
  changed: boolean;
  failures: { field: string; error: unknown }[];
}

export type FileResult =
  | { kind: "changed"; file: TFile }
  | { kind: "skipped"; file: TFile; reason: string }
  | { kind: "error"; file: TFile; reason: string; error: unknown };

export interface GenerateOptions {
  presentation?: PresentationMode;
  signal?: AbortSignal;
}

export interface InteractiveGenerateOptions {
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
    const outcome = await addMetadataWithClaude(
      app,
      file,
      settings,
      frontMatter,
      writePolicyFromSettings(settings),
      opts.presentation ?? "interactive",
      opts.signal,
    );
    if (outcome.failures.length > 0) {
      // A write that threw is not "nothing to do": the request was made and
      // billed, and the note did not get what the user asked for. Report it as
      // an error so the bulk summary counts it and the single-note flow shows a
      // notice, both of which treat "skipped" as unremarkable.
      const fields = outcome.failures.map((f) => f.field).join(", ");
      const partial = outcome.changed ? " (other fields were written)" : "";
      return {
        kind: "error",
        file,
        reason: `failed to write frontmatter: ${fields}${partial}`,
        error: outcome.failures[0]?.error,
      };
    }
    return outcome.changed
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
  opts: InteractiveGenerateOptions = {},
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
    logError({
      event: "generation_failed",
      file: file.path,
      errorKind:
        result.error instanceof ClaudeApiError ? result.error.kind : "unknown",
      errorMessage:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
      errorName: result.error instanceof Error ? result.error.name : undefined,
      errorStack:
        result.error instanceof Error ? result.error.stack : undefined,
    });
  }
}

async function addMetadataWithClaude(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  policy: WritePolicy,
  presentation: PresentationMode,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  const isBulk = presentation === "bulk";
  const requestId = newRequestId();

  const contentStr = settings.truncateContent
    ? await getContent(
        app,
        file,
        settings.contentTokenLimit,
        settings.truncateMethod,
      )
    : await getContent(app, file, -1, "head_only");

  const { system, userMessage } = buildPrompt(contentStr, settings);

  if (settings.debugLogging) {
    logDebug({
      event: "claude_request_start",
      file: file.path,
      model: settings.anthropicModel,
      requestId,
      promptLength: system.length,
      contentLength: userMessage.length,
    });
  }

  const notice = isBulk ? undefined : new Notice("Generating metadata...", 0);
  const startedAt = Date.now();
  let metadata: MetadataFields;
  try {
    metadata = await callClaudeForMetadata(system, userMessage, settings, {
      signal,
    });
  } catch (error) {
    if (settings.debugLogging) {
      logDebug({
        event: "claude_request_failed",
        file: file.path,
        model: settings.anthropicModel,
        requestId,
        durationMs: Date.now() - startedAt,
        errorKind: error instanceof ClaudeApiError ? error.kind : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    notice?.hide();
  }

  if (settings.debugLogging) {
    logDebug({
      event: "claude_request_completed",
      file: file.path,
      model: settings.anthropicModel,
      requestId,
      durationMs: Date.now() - startedAt,
    });
  }

  const failures: WriteOutcome["failures"] = [];

  if (signal?.aborted) {
    return { changed: false, failures };
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
      // Under only_empty the decision to overwrite must be made against the
      // live frontmatter, not `frontMatter` — that snapshot was taken before a
      // request that can run for REQUEST_TIMEOUT_MS (#178). The append path
      // above needs no such guard: it merges with the live value, so a
      // concurrent edit survives either way.
      if (policy === "only_empty") {
        return await updateFrontMatter(
          app,
          file,
          u.fieldName,
          u.value,
          "update_if_empty",
        );
      }
      return await updateFrontMatter(app, file, u.fieldName, u.value, "update");
    } catch (error) {
      if (!isBulk) {
        new Notice(
          `Failed to write ${u.fieldName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      logError({
        event: "frontmatter_write_failed",
        file: file.path,
        requestId,
        field: u.fieldName,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      failures.push({ field: u.fieldName, error });
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
      return { changed: hasChanges, failures };
    }
    const resolved = resolveUpdateMethod(policy, frontMatter[u.fieldName]);
    if (await writeField(u, resolved)) {
      hasChanges = true;
    }
  }

  return { changed: hasChanges, failures };
}
