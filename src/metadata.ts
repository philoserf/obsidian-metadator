import { type App, Notice, type TFile } from "obsidian";
import {
  ClaudeApiError,
  callClaudeForMetadata,
  type MetadataFields,
} from "./adapters/claude";
import { updateFrontMatter } from "./adapters/frontmatter";
import { getContent } from "./content/getContent";
import { isEmptyValue } from "./emptyValue";
import { isAbortError } from "./errors";
import { acquire, release } from "./inFlight";
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

// "Starts with a quote and ends with a quote" is not the same as "is quoted".
// A title that merely opens and closes with quoted phrases satisfied the old
// test and lost its outer characters: `"Hello" and "Goodbye"` became
// `Hello" and "Goodbye`, leaving unbalanced quotes in the note (#206).
//
// The interior check is what separates the two cases. A genuinely wrapped
// title has no further copy of its own delimiter inside it, so `"It's here"`
// still unwraps — the delimiter is `"` and the interior only holds `'`.
//
// An apostrophe inside a word is not a delimiter, so it does not count: that
// keeps `'It's a Wonderful Life'` unwrapping.
//
// What is left is genuinely ambiguous. `"The "Great" Gatsby"` is wrapped and
// `"Hello" and "Goodbye"` is not, and nothing about their shape distinguishes
// them. Both are left alone, because a stray pair of quotes is cosmetic while
// slicing characters off a title the user then has to repair is not.
export function stripSurroundingQuotes(str: string): string {
  const trimmed = str.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    const inner = trimmed.slice(1, -1);
    const significant =
      first === "'" ? inner.replace(/(\p{L})'(\p{L})/gu, "$1$2") : inner;
    if (!significant.includes(first)) return inner;
  }
  return trimmed;
}

// Recognised by generateMetadata so the interactive path can say something
// useful instead of the generic "no changes".
export const ALREADY_IN_PROGRESS = "already generating metadata for this note";

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
  bulk?: boolean;
  signal?: AbortSignal;
}

export interface InteractiveGenerateOptions {
  signal?: AbortSignal;
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

  // Guards both entry points at the one place they share. Without it, a
  // double-triggered hotkey — or the single-note command run on a file a
  // folder pass is already working through — makes two billed calls whose
  // writes both derive from equally stale pre-call snapshots.
  // Captured once: Obsidian mutates TFile.path in place on rename (which is
  // why its rename event has to hand you oldPath separately), so releasing
  // file.path after a multi-second call could release a different key than the
  // one acquired and leak the original for the rest of the session.
  const lockPath = file.path;
  if (!acquire(lockPath)) {
    return { kind: "skipped", file, reason: ALREADY_IN_PROGRESS };
  }

  try {
    const outcome = await addMetadataWithClaude(
      app,
      file,
      settings,
      frontMatter,
      settings.updateMethod === "preserve_existing",
      opts.bulk ?? false,
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
  } finally {
    release(lockPath);
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
  } else if (
    result.kind === "skipped" &&
    result.reason === ALREADY_IN_PROGRESS
  ) {
    new Notice("Already generating metadata for this note");
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
  preserveExisting: boolean,
  isBulk: boolean,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  const requestId = newRequestId();

  const contentStr = settings.truncateContent
    ? await getContent(
        app,
        file,
        settings.contentTokenLimit,
        settings.truncateMethod,
      )
    : await getContent(app, file, -1, "head_only");

  const { system, userMessage } = buildPrompt(
    contentStr,
    settings,
    `article-${requestId}`,
  );

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

  async function writeField(u: FieldUpdate): Promise<boolean> {
    try {
      if (u.updateMethod === "append") {
        return await updateFrontMatter(
          app,
          file,
          u.fieldName,
          u.value,
          "append",
        );
      }
      // Under preserve_existing the decision to overwrite must be made against the
      // live frontmatter, not `frontMatter` — that snapshot was taken before a
      // request that can run for REQUEST_TIMEOUT_MS (#178). The append path
      // above needs no such guard: it merges with the live value, so a
      // concurrent edit survives either way.
      if (preserveExisting) {
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

  // Guarded on the parsed result, not the raw string. A model returning ","
  // or " , " satisfies validateMetadataInput and is truthy, but parseTags
  // yields [] — which the append path then wrote as an empty tags array and
  // reported as a change, so the user was told "Metadata updated successfully"
  // for content that did not exist (#161).
  const tags = metadata.tags ? parseTags(metadata.tags) : [];
  if (tags.length > 0) {
    updates.push({
      fieldName: settings.tagsFieldName,
      value: tags,
      updateMethod: "append",
    });
  }
  // Same shape as the tags guard: judge the value that would actually be
  // written, not the raw string. validateMetadataInput only checks that these
  // are strings, so "   " reaches here as truthy and wrote a blank description.
  if (metadata.description.trim() !== "") {
    updates.push({
      fieldName: settings.descriptionFieldName,
      value: metadata.description,
      updateMethod: "update",
    });
  }
  // stripSurroundingQuotes trims and can empty the string outright — `""`
  // unwraps to "". Guarding on metadata.title instead let that through and
  // wrote an empty title while reporting "Metadata updated successfully".
  const title = metadata.title ? stripSurroundingQuotes(metadata.title) : "";
  if (settings.enableTitle && title !== "") {
    updates.push({
      fieldName: settings.titleFieldName,
      value: title,
      updateMethod: "update",
    });
  }

  for (const u of updates) {
    if (signal?.aborted) {
      return { changed: hasChanges, failures };
    }
    // A populated field under preserve_existing is left alone — and left alone
    // means not opening the file at all. processFrontMatter serializes and
    // writes back on every call regardless of whether the callback mutated
    // anything, so calling it here cost an mtime bump, a vault modify event and
    // disk I/O per skipped field, per file, across a whole bulk run (#185).
    if (preserveExisting && !isEmptyValue(frontMatter[u.fieldName])) {
      continue;
    }
    if (await writeField(u)) {
      hasChanges = true;
    }
  }

  return { changed: hasChanges, failures };
}
