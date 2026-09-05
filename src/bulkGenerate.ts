import type { App, TFile, TFolder } from "obsidian";
import { ClaudeApiError } from "./adapters/claude";
import { logDebug } from "./logger";
import {
  type FileResult,
  generateMetadataForFile,
  shouldGenerate,
} from "./metadata";
import type { MetadataToolSettings } from "./settings";

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 8_000, 30_000,
];

export function collectCandidates(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  for (const child of folder.children) {
    if ("children" in child) {
      out.push(...collectCandidates(child as TFolder));
    } else {
      const file = child as TFile;
      if (file.extension === "md") out.push(file);
    }
  }
  return out;
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
  shouldAbort?: () => boolean;
  retryDelaysMs?: readonly number[];
  signal?: AbortSignal;
  random?: () => number;
}

function isRateLimitOrOverload(error: unknown): boolean {
  return (
    error instanceof ClaudeApiError &&
    (error.kind === "rate_limit" || error.kind === "overloaded")
  );
}

// Cap server-provided Retry-After at this multiple of the scheduled base
// delay so a misbehaving header can't stall a long bulk run indefinitely.
const RETRY_AFTER_CAP_MULTIPLIER = 2;

export function computeDelayMs(
  baseDelayMs: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (
    error instanceof ClaudeApiError &&
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs)
  ) {
    return Math.min(
      error.retryAfterMs,
      baseDelayMs * RETRY_AFTER_CAP_MULTIPLIER,
    );
  }
  // Full jitter in [0.5x, 1.5x] of base — avoids synchronized retry storms
  // across parallel clients hitting a shared-tenant overload.
  return Math.round(baseDelayMs * (0.5 + random()));
}

const ABORT_POLL_MS = 100;

async function sleepAbortable(
  ms: number,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  if (ms <= 0) return shouldAbort?.() ?? false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return true;
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(ABORT_POLL_MS, remaining)),
    );
  }
  return shouldAbort?.() ?? false;
}

async function runFileWithRetry(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  retryDelaysMs: readonly number[],
  shouldAbort?: () => boolean,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<FileResult> {
  const shouldStop = () =>
    (shouldAbort?.() ?? false) || (signal?.aborted ?? false);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (shouldStop()) {
      return { kind: "skipped", file, reason: "cancelled before attempt" };
    }
    const r = await generateMetadataForFile(app, file, settings, {
      bulk: true,
      signal,
    });
    if (r.kind !== "error" || !isRateLimitOrOverload(r.error)) return r;
    if (attempt === retryDelaysMs.length) return r;
    const delayMs = computeDelayMs(retryDelaysMs[attempt], r.error, random);
    if (settings.debugLogging) {
      logDebug({
        event: "claude_retry_scheduled",
        file: file.path,
        attempt: attempt + 1,
        durationMs: delayMs,
        errorKind: r.error instanceof ClaudeApiError ? r.error.kind : "unknown",
      });
    }
    const aborted = await sleepAbortable(delayMs, shouldStop);
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
  {
    onProgress,
    shouldAbort,
    retryDelaysMs,
    signal,
    random,
  }: RunBulkOptions = {},
): Promise<FileResult[]> {
  const delays = retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const results: FileResult[] = [];
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    if (shouldAbort?.() || signal?.aborted) break;
    const file = files[i];
    onProgress?.({ current: i + 1, total: files.length, file, errors });
    const result = await runFileWithRetry(
      app,
      file,
      settings,
      delays,
      shouldAbort,
      signal,
      random,
    );
    results.push(result);
    if (result.kind === "error") errors++;
  }

  return results;
}
