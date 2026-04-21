import { type App, Modal, type TFile } from "obsidian";
import type { FileResult } from "./metadata";
import type { MetadataToolSettings } from "./settings";

const LARGE_BATCH_THRESHOLD = 100;

export interface ConfirmModalInfo {
  folderPath: string;
  total: number;
  willChange: number;
  willSkip: number;
  settings: MetadataToolSettings;
}

export class BulkConfirmModal extends Modal {
  private resolver?: (confirmed: boolean) => void;
  private resolved = false;
  private info: ConfirmModalInfo;

  constructor(app: App, info: ConfirmModalInfo) {
    super(app);
    this.info = info;
  }

  openAndAwait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    const { folderPath, total, willChange, willSkip, settings } = this.info;

    contentEl.createEl("h2", { text: "Generate metadata for folder" });
    contentEl.createEl("p", { text: `Folder: ${folderPath}` });
    contentEl.createEl("p", {
      text: `${total} notes — ${willChange} will change, ${willSkip} will skip`,
    });
    const truncLabel = settings.truncateContent
      ? settings.truncateMethod
      : "disabled";
    contentEl.createEl("p", {
      text: `Model: ${settings.anthropicModel} · Update: ${settings.updateMethod} · Truncation: ${truncLabel}`,
    });

    if (total > LARGE_BATCH_THRESHOLD) {
      const warn = contentEl.createEl("p", {
        text: `⚠ Large batch — this will make up to ${willChange} API calls`,
      });
      warn.style.color = "var(--text-warning)";
      warn.style.fontWeight = "bold";
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.finish(false));
    const confirmBtn = buttons.createEl("button", {
      text: `Generate (${willChange})`,
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.finish(false);
    this.contentEl.empty();
  }

  private finish(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolver?.(value);
    this.close();
  }
}

export class BulkProgressModal extends Modal {
  private aborted = false;
  private statusEl?: HTMLElement;
  private cancelBtn?: HTMLButtonElement;

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Generating metadata" });
    this.statusEl = contentEl.createEl("p", { text: "Starting…" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelBtn = buttons.createEl("button", { text: "Cancel" });
    this.cancelBtn.addEventListener("click", () => {
      this.aborted = true;
      if (this.cancelBtn) {
        this.cancelBtn.disabled = true;
        this.cancelBtn.textContent = "Cancelling…";
      }
    });
  }

  setProgress(p: {
    current: number;
    total: number;
    file: TFile;
    errors: number;
  }): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = `${p.current} / ${p.total} · ${p.file.path} · errors: ${p.errors}`;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  onClose(): void {
    this.aborted = true;
    this.contentEl.empty();
  }
}

export class BulkSummaryModal extends Modal {
  private results: FileResult[];
  private aborted: boolean;
  private totalPlanned: number;

  constructor(
    app: App,
    results: FileResult[],
    aborted: boolean,
    totalPlanned: number,
  ) {
    super(app);
    this.results = results;
    this.aborted = aborted;
    this.totalPlanned = totalPlanned;
  }

  onOpen(): void {
    const { contentEl } = this;
    const changed = this.results.filter((r) => r.kind === "changed").length;
    const skipped = this.results.filter((r) => r.kind === "skipped").length;
    const errors = this.results.filter((r) => r.kind === "error");
    const remaining = this.totalPlanned - this.results.length;

    contentEl.createEl("h2", {
      text: this.aborted ? "Cancelled" : "Finished",
    });
    const summary = contentEl.createEl("ul");
    summary.createEl("li", { text: `${changed} changed` });
    summary.createEl("li", { text: `${skipped} skipped` });
    summary.createEl("li", { text: `${errors.length} errored` });
    if (remaining > 0) {
      summary.createEl("li", {
        text: `${remaining} not processed (cancelled)`,
      });
    }

    if (errors.length > 0) {
      contentEl.createEl("h3", { text: "Errors" });
      const errList = contentEl.createEl("ul");
      for (const e of errors) {
        if (e.kind === "error") {
          errList.createEl("li", { text: `${e.file.path}: ${e.reason}` });
        }
      }
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const closeBtn = buttons.createEl("button", {
      text: "Close",
      cls: "mod-cta",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
