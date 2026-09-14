import { type App, Modal } from "obsidian";
import { REQUESTS_PER_ATTEMPT } from "./adapters/claude";
import { exceedsBulkCap } from "./bulkGenerate";
import { DEFAULT_RETRY_DELAYS_MS } from "./retryPolicy";
import type { MetadataToolSettings } from "./settings";

const LARGE_BATCH_THRESHOLD = 100;

// Worst case, not best: every file can be attempted once and then retried on
// the full bulk schedule, and each of those attempts is itself several HTTP
// requests because the SDK retries underneath us. Both figures are imported
// rather than hard-coded so the copy cannot drift from the real policy.
export function worstCaseApiCalls(
  willChange: number,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): number {
  return willChange * (retryDelaysMs.length + 1) * REQUESTS_PER_ATTEMPT;
}

export interface BulkConfirmResult {
  confirmed: boolean;
  // True only if the user ticked the over-cap override for this run.
  capOverridden: boolean;
}

export interface ConfirmModalInfo {
  folderPath: string;
  total: number;
  willChange: number;
  willSkip: number;
  settings: MetadataToolSettings;
}

export class BulkConfirmModal extends Modal {
  private resolver?: (result: BulkConfirmResult) => void;
  private resolved = false;
  private info: ConfirmModalInfo;

  constructor(app: App, info: ConfirmModalInfo) {
    super(app);
    this.info = info;
  }

  // Reports the override rather than keeping it: a disabled button is a UI
  // affordance, not a gate, so runBulkForFolder re-checks the cap itself and
  // needs to know whether the user actually ticked the box (#238).
  openAndAwait(): Promise<BulkConfirmResult> {
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
      text: `Model: ${settings.anthropicModel} · Truncation: ${truncLabel}`,
    });
    // On its own line rather than folded into the row above: since #252 the
    // tags policy can *remove* tags, and title can overwrite, so what this run
    // will do to existing values is the thing worth reading before approving
    // hundreds of billed calls across a folder.
    const titlePolicy = settings.enableTitle
      ? settings.titlePolicy
      : "disabled";
    contentEl.createEl("p", {
      text: `Write policy — tags: ${settings.tagsPolicy} · description: ${settings.descriptionPolicy} · title: ${titlePolicy}`,
    });

    // Gauged on willChange, not total: a folder of 500 already-tagged notes
    // with 3 to generate is not a large batch, and 90 notes that all need
    // generating is. willChange is also what the cap gate below tests.
    if (willChange > LARGE_BATCH_THRESHOLD) {
      const warn = contentEl.createEl("p", {
        text: `⚠ Large batch — ${willChange} notes, up to ${worstCaseApiCalls(willChange)} API calls if rate limits force retries`,
      });
      warn.style.color = "var(--text-warning)";
      warn.style.fontWeight = "bold";
    }

    const exceedsCap = exceedsBulkCap(willChange, settings);
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
      this.resolve(true, overrideEl?.checked ?? false);
      this.close();
    });
  }

  onClose(): void {
    // Fires on both button-driven close and Esc/X; resolve(false) is a no-op
    // if a button already resolved, so Esc defaults to cancel.
    this.resolve(false);
    this.contentEl.empty();
  }

  private resolve(confirmed: boolean, capOverridden = false): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolver?.({ confirmed, capOverridden });
  }
}
