import { type App, Modal } from "obsidian";
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

    const exceedsCap = willChange > settings.maxBulkFiles;
    let overrideEl: HTMLInputElement | undefined;
    if (exceedsCap) {
      const cap = contentEl.createEl("p", {
        text: `⛔ Exceeds the configured limit of ${settings.maxBulkFiles} files. Raise "Max Bulk Files" in Settings → Metadator, or check the box below to override for this run only.`,
      });
      cap.style.color = "var(--text-error)";
      cap.style.fontWeight = "bold";

      const overrideRow = contentEl.createDiv();
      overrideEl = overrideRow.createEl("input", {
        attr: { type: "checkbox", id: "metadator-override-cap" },
      }) as HTMLInputElement;
      const label = overrideRow.createEl("label", {
        text: ` I understand and want to proceed with ${willChange} files`,
        attr: { for: "metadator-override-cap" },
      });
      label.style.marginLeft = "0.4em";
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.resolve(false);
      this.close();
    });
    const confirmBtn = buttons.createEl("button", {
      text: `Generate (${willChange})`,
      cls: "mod-cta",
    });
    if (exceedsCap && overrideEl) {
      confirmBtn.disabled = true;
      overrideEl.addEventListener("change", () => {
        confirmBtn.disabled = !overrideEl?.checked;
      });
    }
    confirmBtn.addEventListener("click", () => {
      this.resolve(true);
      this.close();
    });
  }

  onClose(): void {
    // Fires on both button-driven close and Esc/X; resolve(false) is a no-op
    // if a button already resolved, so Esc defaults to cancel.
    this.resolve(false);
    this.contentEl.empty();
  }

  private resolve(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolver?.(value);
  }
}
