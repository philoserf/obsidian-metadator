import type { App, TFile } from "obsidian";
import {
  ClaudeApiError,
  callClaudeForMetadata,
  type MetadataFields,
} from "./adapters/claude";
import { updateFrontMatter } from "./adapters/frontmatter";
import { getContent } from "./content/getContent";
import { isEmptyValue } from "./emptyValue";
import { FrontmatterWriteError, isAbortError } from "./errors";
import { acquire, release } from "./inFlight";
import { logDebug, logError, newRequestId } from "./logger";
import { buildPrompt, normalizeTags, readExistingTags } from "./prompt";
import type {
  MetadataToolSettings,
  ScalarPolicy,
  TagsPolicy,
} from "./settings";

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

// Why a file was passed over. A closed union, not prose: six of these mean
// materially different things to a user, and two are load-bearing —
// "nothing_written" is the only skip that follows a *billed* API call, and
// "locked" is the only one that means "try again in a minute". Recovering that
// from a sentence meant an exported string constant compared with === , which
// is a missing case in the union wearing a disguise, and it only ever scaled
// to the one case someone needed (#234).
//
// The rule this encodes: prose may be displayed, never matched.
export type SkipReason =
  | "not_markdown"
  | "no_api_key"
  | "already_populated"
  | "cancelled"
  | "locked"
  | "nothing_written";

// A `preserve` field is the only one that can make a request pointless: every
// other policy writes whatever comes back. So the question is whether any
// enabled field would write, and a note where all three are preserved and all
// three are populated is the one case worth not billing a call for.
function willWrite(
  policy: TagsPolicy | ScalarPolicy,
  existing: unknown,
): boolean {
  return policy === "preserve" ? isEmptyValue(existing) : true;
}

export function shouldGenerate(
  frontMatter: Record<string, unknown>,
  settings: MetadataToolSettings,
): boolean {
  return (
    willWrite(settings.tagsPolicy, frontMatter[settings.tagsFieldName]) ||
    willWrite(
      settings.descriptionPolicy,
      frontMatter[settings.descriptionFieldName],
    ) ||
    (settings.enableTitle &&
      willWrite(settings.titlePolicy, frontMatter[settings.titleFieldName]))
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
  | { kind: "skipped"; file: TFile; reason: SkipReason }
  | { kind: "error"; file: TFile; reason: string; error: unknown };

export interface GenerateOptions {
  signal?: AbortSignal;
}

export async function generateMetadataForFile(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  opts: GenerateOptions = {},
): Promise<FileResult> {
  if (file.extension !== "md") {
    return { kind: "skipped", file, reason: "not_markdown" };
  }

  if (!settings.anthropicApiKey) {
    return { kind: "skipped", file, reason: "no_api_key" };
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};

  if (!shouldGenerate(frontMatter, settings)) {
    return { kind: "skipped", file, reason: "already_populated" };
  }

  if (opts.signal?.aborted) {
    return { kind: "skipped", file, reason: "cancelled" };
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
    return { kind: "skipped", file, reason: "locked" };
  }

  try {
    const outcome = await addMetadataWithClaude(
      app,
      file,
      settings,
      frontMatter,
      opts.signal,
    );
    if (outcome.failures.length > 0) {
      // A write that threw is not "nothing to do": the request was made and
      // billed, and the note did not get what the user asked for. Report it as
      // an error so the bulk summary counts it and the single-note flow shows a
      // notice, both of which treat "skipped" as unremarkable.
      const fields = outcome.failures.map((f) => f.field);
      const partial = outcome.changed ? " (other fields were written)" : "";
      return {
        kind: "error",
        file,
        reason: `failed to write frontmatter: ${fields.join(", ")}${partial}`,
        error: new FrontmatterWriteError(fields, outcome.failures[0]?.error),
      };
    }
    return outcome.changed
      ? { kind: "changed", file }
      : { kind: "skipped", file, reason: "nothing_written" };
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

async function addMetadataWithClaude(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  const requestId = newRequestId();

  // truncateContent: false is a limit of "no limit", which is what -1 means to
  // getContent — so the toggle is one argument, not two spellings of the call.
  const contentStr = await getContent(
    app,
    file,
    settings.truncateContent ? settings.contentTokenLimit : -1,
    settings.truncateMethod,
  );

  const { system, userMessage } = buildPrompt(
    contentStr,
    settings,
    `article-${requestId}`,
    readExistingTags(frontMatter[settings.tagsFieldName]),
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

  // Each field carries its own policy, so the write method is decided per
  // field rather than from one global flag (#252). `kind` is what separates a
  // list from a scalar: the three policies are spelled identically across the
  // fields on purpose, so `regenerate` alone cannot say which write to use.
  type FieldUpdate =
    | { kind: "list"; fieldName: string; value: string[]; policy: TagsPolicy }
    | {
        kind: "scalar";
        fieldName: string;
        value: string;
        policy: ScalarPolicy;
      };

  // `preserve` re-checks emptiness against the live frontmatter inside
  // processFrontMatter rather than the `frontMatter` snapshot, which was taken
  // before a request that can run for REQUEST_TIMEOUT_MS — otherwise a value
  // the user typed during the call gets overwritten (#178). `merge` needs no
  // such guard because it unions with the live value, so a concurrent edit
  // survives either way; `regenerate` is asked for explicitly.
  function methodFor(
    u: FieldUpdate,
  ): "append" | "replace" | "update" | "update_if_empty" {
    if (u.policy === "preserve") return "update_if_empty";
    if (u.policy === "merge") return "append";
    // One policy, two writes. A list is replaced wholesale — "replace" is the
    // array-typed counterpart of "update", because "update" is typed for a
    // scalar and would write the list as a comma-joined string, after which
    // Obsidian stops indexing the field (#230).
    return u.kind === "list" ? "replace" : "update";
  }

  async function writeField(u: FieldUpdate): Promise<boolean> {
    try {
      return await updateFrontMatter(
        app,
        file,
        u.fieldName,
        u.value,
        methodFor(u),
      );
    } catch (error) {
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

  // Guarded on the normalized result, not the raw field. A model returning
  // ["", "  "] satisfies validateMetadataInput but normalizeTags yields [] —
  // which the append path then wrote as an empty tags array and reported as a
  // change, so the user was told "Metadata updated successfully" for content
  // that did not exist (#161).
  const tags = normalizeTags(metadata.tags);
  if (tags.length > 0) {
    updates.push({
      kind: "list",
      fieldName: settings.tagsFieldName,
      value: tags,
      policy: settings.tagsPolicy,
    });
  }
  // Same shape as the tags guard: judge the value that would actually be
  // written, not the raw string. validateMetadataInput only checks that these
  // are strings, so "   " reaches here as truthy and wrote a blank description.
  if (metadata.description.trim() !== "") {
    updates.push({
      kind: "scalar",
      fieldName: settings.descriptionFieldName,
      value: metadata.description,
      policy: settings.descriptionPolicy,
    });
  }
  // stripSurroundingQuotes trims and can empty the string outright — `""`
  // unwraps to "". Guarding on metadata.title instead let that through and
  // wrote an empty title while reporting "Metadata updated successfully".
  const title = metadata.title ? stripSurroundingQuotes(metadata.title) : "";
  if (settings.enableTitle && title !== "") {
    updates.push({
      kind: "scalar",
      fieldName: settings.titleFieldName,
      value: title,
      policy: settings.titlePolicy,
    });
  }

  for (const u of updates) {
    if (signal?.aborted) {
      return { changed: hasChanges, failures };
    }
    // A populated field under `preserve` is left alone — and left alone means
    // not opening the file at all. processFrontMatter serializes and writes
    // back on every call regardless of whether the callback mutated anything,
    // so calling it here cost an mtime bump, a vault modify event and disk I/O
    // per skipped field, per file, across a whole bulk run (#185).
    if (u.policy === "preserve" && !isEmptyValue(frontMatter[u.fieldName])) {
      continue;
    }
    if (await writeField(u)) {
      hasChanges = true;
    }
  }

  return { changed: hasChanges, failures };
}
