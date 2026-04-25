import { type App, Notice, type TFolder } from "obsidian";
import { classifyCandidates, collectCandidates, runBulk } from "./bulkGenerate";
import {
  BulkConfirmModal,
  BulkProgressModal,
  BulkSummaryModal,
} from "./bulkModals";
import type { MetadataToolSettings } from "./settings";

export interface RunBulkForFolderOptions {
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
}

export async function runBulkForFolder(
  app: App,
  folder: TFolder,
  settings: MetadataToolSettings,
  opts: RunBulkForFolderOptions = {},
): Promise<void> {
  if (!settings.anthropicApiKey) {
    new Notice(
      "Please configure your Anthropic API key in Settings → Metadator",
      8000,
    );
    return;
  }

  const files = collectCandidates(folder);
  if (files.length === 0) {
    new Notice("No markdown files found in folder");
    return;
  }

  const { willChange, willSkip } = classifyCandidates(app, files, settings);
  if (willChange.length === 0) {
    new Notice(
      `All ${files.length} notes already have metadata; nothing to do`,
    );
    return;
  }

  const confirmed = await new BulkConfirmModal(app, {
    folderPath: folder.path,
    total: files.length,
    willChange: willChange.length,
    willSkip: willSkip.length,
    settings,
  }).openAndAwait();
  if (!confirmed) return;

  const progress = new BulkProgressModal(app);
  const runController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      runController.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener(
        "abort",
        () => runController.abort(opts.signal?.reason),
        { once: true },
      );
    }
  }
  progress.setAbortHandler(() => runController.abort("cancelled_by_user"));
  progress.open();

  const results = await runBulk(app, willChange, settings, {
    onProgress: (p) => progress.setProgress(p),
    shouldAbort: () => (opts.shouldAbort?.() ?? false) || progress.isAborted(),
    signal: runController.signal,
  });

  const aborted =
    progress.isAborted() ||
    (opts.shouldAbort?.() ?? false) ||
    runController.signal.aborted;
  progress.finish();

  new BulkSummaryModal(app, results, aborted, willChange.length).open();
}
