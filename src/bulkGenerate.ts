import Anthropic from "@anthropic-ai/sdk";
import type { App, TFile, TFolder } from "obsidian";
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
}

function isRateLimitOrOverload(error: unknown): boolean {
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFileWithRetry(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  retryDelaysMs: readonly number[],
  shouldAbort?: () => boolean,
): Promise<FileResult> {
  let last: FileResult | undefined;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const r = await generateMetadataForFile(app, file, settings, {
      isBulk: true,
    });
    last = r;
    if (r.kind !== "error" || !isRateLimitOrOverload(r.error)) return r;
    if (attempt === retryDelaysMs.length) return r;
    await sleep(retryDelaysMs[attempt]);
    if (shouldAbort?.()) return r;
  }
  return last as FileResult;
}

export async function runBulk(
  app: App,
  files: TFile[],
  settings: MetadataToolSettings,
  { onProgress, shouldAbort, retryDelaysMs }: RunBulkOptions = {},
): Promise<FileResult[]> {
  const delays = retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const results: FileResult[] = [];
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    if (shouldAbort?.()) break;
    const file = files[i];
    onProgress?.({ current: i + 1, total: files.length, file, errors });
    const result = await runFileWithRetry(
      app,
      file,
      settings,
      delays,
      shouldAbort,
    );
    results.push(result);
    if (result.kind === "error") errors++;
  }

  return results;
}
