import { type App, Modal } from "obsidian";
import type { BulkHalt } from "./bulkGenerate";
import type { FileResult } from "./metadata";

export interface SummaryModalInfo {
  aborted: boolean;
  halted?: BulkHalt;
  totalPlanned: number;
}

// A halt is not the user's doing, so it must not read as "Cancelled", and it is
// not a completed pass either. Each kind gets the sentence that says what to go
// and fix, since the error list below will be a single repeated row.
function haltExplanation(halt: BulkHalt): string {
  switch (halt.kind) {
    case "auth":
      return "Authentication failed — check your API key in Settings → Metadator.";
    case "rate_limit":
      return "Rate limited repeatedly, even after retries. Try again later.";
    case "overloaded":
      return "The API stayed overloaded across retries. Try again later.";
    default:
      return `${halt.consecutive} notes in a row failed the same way: ${halt.message}`;
  }
}

export class BulkSummaryModal extends Modal {
  private results: FileResult[];
  private info: SummaryModalInfo;

  constructor(app: App, results: FileResult[], info: SummaryModalInfo) {
    super(app);
    this.results = results;
    this.info = info;
  }

  onOpen(): void {
    const { contentEl } = this;
    const changed = this.results.filter((r) => r.kind === "changed").length;
    const skipped = this.results.filter((r) => r.kind === "skipped").length;
    const errors = this.results.filter((r) => r.kind === "error");
    const { aborted, halted, totalPlanned } = this.info;
    const remaining = totalPlanned - this.results.length;

    let heading: string;
    if (halted) heading = "Stopped early";
    else if (aborted) heading = "Cancelled";
    else heading = "Finished";
    contentEl.createEl("h2", { text: heading });

    if (halted) {
      const note = contentEl.createEl("p", { text: haltExplanation(halted) });
      note.style.color = "var(--text-error)";
      note.style.fontWeight = "bold";
    }
    const summary = contentEl.createEl("ul");
    summary.createEl("li", { text: `${changed} changed` });
    summary.createEl("li", { text: `${skipped} skipped` });
    summary.createEl("li", { text: `${errors.length} errored` });
    if (remaining > 0) {
      summary.createEl("li", {
        text: `${remaining} not processed (${halted ? "stopped early" : "cancelled"})`,
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
