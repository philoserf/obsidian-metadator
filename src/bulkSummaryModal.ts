import { type App, Modal } from "obsidian";
import type { FileResult } from "./metadata";

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
