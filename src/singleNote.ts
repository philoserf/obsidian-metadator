import { type App, Notice } from "obsidian";
import { ClaudeApiError } from "./adapters/claude";
import { FrontmatterWriteError } from "./errors";
import { logError } from "./logger";
import { generateMetadataForFile, type SkipReason } from "./metadata";
import type { MetadataToolSettings } from "./settings";

// The single-note presentation layer, mirroring bulkOrchestrator.ts. Every
// user-facing sentence for this entry point lives here; metadata.ts returns
// data and renders nothing (#239). Before the split it did both, and the two
// collided — one failed frontmatter write produced four notices, the last of
// which called it an "Unexpected error", the wording reserved for an unknown
// API failure, sending the user to check an API key that was fine.

export interface InteractiveGenerateOptions {
  signal?: AbortSignal;
}

function notifyError(error: unknown): void {
  // Checked before the ClaudeApiError branches: a write failure never reached
  // the API, and without this it fell through to the generic bottom case and
  // was reported as "Unexpected error" (#239).
  if (error instanceof FrontmatterWriteError) {
    new Notice(
      `Could not write ${error.fields.join(", ")} to this note's frontmatter: ${
        error.cause instanceof Error ? error.cause.message : String(error.cause)
      }`,
      8000,
    );
    return;
  }
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
      case "connection":
        new Notice(
          "Could not reach the API. Check your network connection and try again.",
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

// Every skip gets a sentence. The command used to fall off the end of an
// else-if chain for four of the six, so running it on a fully-populated note
// produced no notice, no log and no modal — indistinguishable from a broken
// hotkey (#237).
function skipNotice(reason: SkipReason): string | undefined {
  switch (reason) {
    case "not_markdown":
      return "Current file is not a markdown file";
    case "no_api_key":
      return "Please configure your Anthropic API key in Settings → Metadator";
    case "already_populated":
      return "Every field is already populated — nothing to generate";
    case "cancelled":
      return "Generation cancelled";
    case "locked":
      return "Already generating metadata for this note";
    case "nothing_written":
      // The only skip that follows a billed call, so it says so rather than
      // sharing the quiet "nothing to do" wording.
      return "The model returned nothing usable, so nothing was written. The request was still billed.";
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

  // The "not markdown" and "no API key" guards are gone from here: they were
  // duplicated with generateMetadataForFile five lines later, purely so this
  // path could word them itself. With typed reasons the wrapper renders them
  // from the result instead. Only the no-file guard stays, because there is no
  // file to pass.
  const notice = new Notice("Generating metadata...", 0);
  let result: Awaited<ReturnType<typeof generateMetadataForFile>>;
  try {
    result = await generateMetadataForFile(app, file, settings, {
      signal: opts.signal,
    });
  } finally {
    notice.hide();
  }

  if (result.kind === "changed") {
    new Notice("Metadata updated successfully");
    return;
  }

  if (result.kind === "skipped") {
    const message = skipNotice(result.reason);
    if (message) new Notice(message);
    return;
  }

  notifyError(result.error);
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
    errorStack: result.error instanceof Error ? result.error.stack : undefined,
  });
}
