import { Modal, type TFile } from "obsidian";

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

  // Orchestrator calls finish() after the run completes normally. Direct
  // close() (or Esc) leaves finishing=false, so onClose treats it as abort.
  finish(): void {
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
