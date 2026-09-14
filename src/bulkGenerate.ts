import { type App, TFile, TFolder } from "obsidian";
import { ClaudeApiError } from "./adapters/claude";
import { logDebug } from "./logger";
import {
  type FileResult,
  generateMetadataForFile,
  shouldGenerate,
} from "./metadata";
import {
  computeDelayMs,
  DEFAULT_RETRY_DELAYS_MS,
  type HaltKind,
  haltKindOf,
  haltStreakFor,
  isRetryable,
  scheduleFor,
} from "./retryPolicy";
import type { MetadataToolSettings } from "./settings";

// The cap is policy, and policy lives in this layer. It used to exist only as
// a computed boolean inside BulkConfirmModal — a red paragraph and a disabled
// button — which put a data-and-money safety limit in the one layer this
// codebase otherwise keeps free of decisions, and left it untestable from the
// headless suite that covers retry, halt and abort in detail.
//
// Gauged on files-that-will-change rather than files scanned: a folder of 500
// already-populated notes with three to generate is not a large run, and 90
// that all need generating is.
export function exceedsBulkCap(
  willChange: number,
  settings: MetadataToolSettings,
): boolean {
  return willChange > settings.maxBulkFiles;
}

export function collectCandidates(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  collectInto(folder, out);
  // Sorted once over the whole tree, not per level, which would order each
  // folder's children but still interleave subtrees. folder.children order is
  // not guaranteed, so without this the progress display and the summary's
  // error list come out differently from run to run and across platforms.
  // The locale is pinned rather than left to the host: bare localeCompare()
  // inherits the machine's default, so the same vault would order differently
  // elsewhere — the exact thing this sort exists to stop. "en" collation is
  // what Obsidian's file explorer shows, which is the list a user comparing
  // against the progress display actually has in front of them.
  return out.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function collectInto(folder: TFolder, out: TFile[]): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      collectInto(child, out);
    } else if (child instanceof TFile && child.extension === "md") {
      out.push(child);
    }
  }
}

export function classifyCandidates(
  app: App,
  files: TFile[],
  settings: MetadataToolSettings,
): { willChange: TFile[]; willSkip: TFile[] } {
  const willChange: TFile[] = [];
  const willSkip: TFile[] = [];
  for (const file of files) {
    const frontMatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    if (shouldGenerate(frontMatter, settings)) {
      willChange.push(file);
    } else {
      willSkip.push(file);
    }
  }
  return { willChange, willSkip };
}

export interface BulkProgress {
  current: number;
  total: number;
  file: TFile;
  errors: number;
}

export interface RunBulkOptions {
  onProgress?: (p: BulkProgress) => void;
  retryDelaysMs?: readonly number[];
  signal?: AbortSignal;
  random?: () => number;
}

export interface BulkHalt {
  kind: HaltKind;
  message: string;
  consecutive: number;
}

export interface BulkRunOutcome {
  results: FileResult[];
  halted?: BulkHalt;
}

// Resolves true if the wait was cut short by an abort. Event-driven rather
// than a polling loop: cancelling during a 30-second backoff is now immediate
// instead of up to a poll interval late, and there is no interval constant to
// pick. The listener is removed in the finally because `signal` outlives this
// call — it is the per-run controller's, and a bulk run awaits this once per
// retry per file.
async function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  if (ms <= 0) return false;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      if (!signal) return;
      onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function runFileWithRetry(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  retryDelaysMs: readonly number[],
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<FileResult> {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (signal?.aborted) {
      return { kind: "skipped", file, reason: "cancelled before attempt" };
    }
    const r = await generateMetadataForFile(app, file, settings, {
      bulk: true,
      signal,
    });
    if (r.kind !== "error" || !isRetryable(r.error)) return r;
    const delays = scheduleFor(r.error, retryDelaysMs);
    if (attempt >= delays.length) return r;
    const delayMs = computeDelayMs(delays[attempt], r.error, random);
    if (settings.debugLogging) {
      logDebug({
        event: "claude_retry_scheduled",
        file: file.path,
        attempt: attempt + 1,
        durationMs: delayMs,
        errorKind: r.error instanceof ClaudeApiError ? r.error.kind : "unknown",
      });
    }
    const aborted = await sleepAbortable(delayMs, signal);
    if (aborted) {
      return {
        kind: "skipped",
        file,
        reason: "cancelled during retry backoff",
      };
    }
  }
  // Unreachable — loop always returns.
  return { kind: "skipped", file, reason: "retry loop exited unexpectedly" };
}

export async function runBulk(
  app: App,
  files: TFile[],
  settings: MetadataToolSettings,
  { onProgress, retryDelaysMs, signal, random }: RunBulkOptions = {},
): Promise<BulkRunOutcome> {
  const delays = retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const results: FileResult[] = [];
  let errors = 0;
  let streakKind: HaltKind | undefined;
  let streak = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;
    const file = files[i];
    onProgress?.({ current: i + 1, total: files.length, file, errors });
    const result = await runFileWithRetry(
      app,
      file,
      settings,
      delays,
      signal,
      random,
    );
    results.push(result);
    if (result.kind !== "error") {
      streakKind = undefined;
      streak = 0;
      continue;
    }
    errors++;

    // Every error kind counts, including rate_limit and overloaded: those only
    // reach here once runFileWithRetry has exhausted the whole backoff
    // schedule, so by this point they are a proven ceiling rather than a blip.
    const kind = haltKindOf(result.error);
    streak = kind === streakKind ? streak + 1 : 1;
    streakKind = kind;

    if (kind === "auth" || streak >= haltStreakFor(kind)) {
      return {
        results,
        halted: {
          kind,
          message:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
          consecutive: streak,
        },
      };
    }
  }

  return { results };
}
