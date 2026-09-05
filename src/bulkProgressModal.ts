import { Modal } from "obsidian";
import type { BulkProgress } from "./bulkGenerate";

export class BulkProgressModal extends Modal {
  private aborted = false;
  private finishing = false;
  private statusEl?: HTMLElement;
  private cancelBtn?: HTMLButtonElement;
  private onAbort?: () => void;

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Generating metadata" });
    this.statusEl = contentEl.createEl("p", { text: "Starting…" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelBtn = buttons.createEl("button", { text: "Cancel" });
    this.cancelBtn.addEventListener("click", () => {
      this.aborted = true;
      this.onAbort?.();
      if (this.cancelBtn) {
        this.cancelBtn.disabled = true;
        this.cancelBtn.textContent = "Cancelling…";
      }
    });
  }

  setAbortHandler(handler: () => void): void {
    this.onAbort = handler;
  }

  setProgress(p: BulkProgress): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = `${p.current} / ${p.total} · ${p.file.path} · errors: ${p.errors}`;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  // Orchestrator calls finish() after the run completes normally. Direct
  // close() (or Esc) leaves finishing=false, so onClose treats it as abort.
  // Idempotent: the orchestrator also calls it from a finally block, which on
  // the normal path runs after this has already closed the modal.
  finish(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.close();
  }

  onClose(): void {
    if (!this.finishing) {
      this.aborted = true;
      this.onAbort?.();
    }
    this.contentEl.empty();
  }
}
