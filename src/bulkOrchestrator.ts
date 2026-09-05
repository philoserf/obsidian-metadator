import { type App, Notice, type TFolder } from "obsidian";
import { BulkConfirmModal } from "./bulkConfirmModal";
import { classifyCandidates, collectCandidates, runBulk } from "./bulkGenerate";
import { BulkProgressModal } from "./bulkProgressModal";
import { BulkSummaryModal } from "./bulkSummaryModal";
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
  // Named so it can be detached in the finally below. { once: true } only
  // self-detaches after the event fires, and opts.signal is the plugin-lifetime
  // controller from onload(), which normally aborts only at onunload(). Without
  // the removal every bulk run would leave another listener — and the closure
  // holding that run's AbortController — attached for the rest of the session.
  const forwardAbort = () => runController.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) {
      runController.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  progress.setAbortHandler(() => runController.abort("cancelled_by_user"));
  progress.open();

  try {
    const { results, halted } = await runBulk(app, willChange, settings, {
      onProgress: (p) => progress.setProgress(p),
      shouldAbort: () =>
        (opts.shouldAbort?.() ?? false) || progress.isAborted(),
      signal: runController.signal,
    });

    const aborted =
      progress.isAborted() ||
      (opts.shouldAbort?.() ?? false) ||
      runController.signal.aborted;
    progress.finish();

    new BulkSummaryModal(app, results, {
      aborted,
      halted,
      totalPlanned: willChange.length,
    }).open();
  } finally {
    // Covers the path where runBulk throws, which would otherwise leave the
    // progress modal open with no summary behind it. finish() is idempotent, so
    // the normal path above having already closed it is fine.
    progress.finish();
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}
