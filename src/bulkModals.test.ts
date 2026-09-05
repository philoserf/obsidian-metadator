import { describe, expect, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { BulkConfirmModal, worstCaseApiCalls } from "./bulkConfirmModal";
import { BulkProgressModal } from "./bulkProgressModal";
import { BulkSummaryModal } from "./bulkSummaryModal";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import type { FakeEl } from "./testDom";

// No mock.module("obsidian") here on purpose. test-preload.ts already installs
// obsidianDoubles, whose Modal is FakeModal — the chaining open()/close() these
// tests need. Re-mocking with fresh TFile/TFolder classes would swap the global
// class identities out from under every test file that loads later, breaking
// their instanceof checks.

const app = {} as App;

function settings(
  overrides: Partial<MetadataToolSettings> = {},
): MetadataToolSettings {
  return { ...DEFAULT_SETTINGS, maxBulkFiles: 50, ...overrides };
}

function contentOf(modal: unknown): FakeEl {
  return (modal as unknown as { contentEl: FakeEl }).contentEl;
}

describe("BulkConfirmModal", () => {
  type ConfirmInfo = ConstructorParameters<typeof BulkConfirmModal>[1];
  function open(info: Partial<ConfirmInfo> = {}) {
    const modal = new BulkConfirmModal(app, {
      folderPath: "notes",
      total: 10,
      willChange: 10,
      willSkip: 0,
      settings: settings(),
      ...info,
    });
    const promise = modal.openAndAwait();
    return { modal, promise, el: contentOf(modal) };
  }

  test("Cancel resolves false", async () => {
    const { promise, el } = open();
    el.findByText("Cancel")?.dispatch("click");
    expect(await promise).toBe(false);
  });

  test("Generate resolves true", async () => {
    const { promise, el } = open();
    el.findByText("Generate (10)")?.dispatch("click");
    expect(await promise).toBe(true);
  });

  test("closing without a button — Esc or X — defaults to cancel", async () => {
    const { modal, promise } = open();
    modal.close();
    expect(await promise).toBe(false);
  });

  test("the first resolution wins; a later close cannot flip it", async () => {
    const { modal, promise, el } = open();
    el.findByText("Generate (10)")?.dispatch("click");
    modal.close();
    expect(await promise).toBe(true);
  });

  test("over the cap, Generate is disabled until the override is checked", async () => {
    const { promise, el } = open({ willChange: 80, total: 80 });
    const confirm = el.findByText("Generate (80)");
    expect(confirm?.disabled).toBe(true);

    const override = el.find((e) => e.attr.type === "checkbox");
    expect(override).toBeDefined();
    if (override) {
      override.checked = true;
      override.dispatch("change");
    }
    expect(confirm?.disabled).toBe(false);

    confirm?.dispatch("click");
    expect(await promise).toBe(true);
  });

  test("under the cap there is no override gate", async () => {
    const { promise, el } = open({ willChange: 10 });
    expect(el.findByText("Generate (10)")?.disabled).toBe(false);
    expect(el.find((e) => e.attr.type === "checkbox")).toBeUndefined();
    el.findByText("Cancel")?.dispatch("click");
    await promise;
  });

  test("the large-batch warning follows willChange, not total", async () => {
    const big = open({ total: 500, willChange: 3, willSkip: 497 });
    expect(big.el.allText().some((t) => t.includes("Large batch"))).toBe(false);
    big.modal.close();
    await big.promise;

    const real = open({ total: 200, willChange: 150, willSkip: 50 });
    const warning = real.el.allText().find((t) => t.includes("Large batch"));
    expect(warning).toBeDefined();
    // 150 files x (3 bulk retries + 1) x the SDK's own requests per attempt
    expect(warning).toContain(`${worstCaseApiCalls(150)} API calls`);
    real.modal.close();
    await real.promise;
  });
});

describe("BulkProgressModal", () => {
  test("finish() closes without reporting an abort", () => {
    const modal = new BulkProgressModal(app);
    let aborts = 0;
    modal.setAbortHandler(() => aborts++);
    modal.open();

    modal.finish();

    expect(modal.isAborted()).toBe(false);
    expect(aborts).toBe(0);
  });

  test("a direct close — Esc or X — counts as a user abort", () => {
    const modal = new BulkProgressModal(app);
    let aborts = 0;
    modal.setAbortHandler(() => aborts++);
    modal.open();

    modal.close();

    expect(modal.isAborted()).toBe(true);
    expect(aborts).toBe(1);
  });

  test("the Cancel button aborts and disables itself", () => {
    const modal = new BulkProgressModal(app);
    let aborts = 0;
    modal.setAbortHandler(() => aborts++);
    modal.open();

    const cancel = contentOf(modal).findByText("Cancel");
    cancel?.dispatch("click");

    expect(modal.isAborted()).toBe(true);
    expect(aborts).toBe(1);
    expect(cancel?.disabled).toBe(true);
    expect(cancel?.textContent).toBe("Cancelling…");
  });

  test("finish() is idempotent, so the orchestrator's finally is safe", () => {
    const modal = new BulkProgressModal(app);
    let aborts = 0;
    modal.setAbortHandler(() => aborts++);
    modal.open();

    modal.finish();
    modal.finish();

    expect(modal.isAborted()).toBe(false);
    expect(aborts).toBe(0);
  });

  test("setProgress renders the current file and error count", () => {
    const modal = new BulkProgressModal(app);
    modal.open();
    modal.setProgress({
      current: 2,
      total: 5,
      file: { path: "n2.md" } as unknown as TFile,
      errors: 1,
    });
    expect(contentOf(modal).allText().join(" ")).toContain(
      "2 / 5 · n2.md · errors: 1",
    );
  });
});

describe("BulkSummaryModal", () => {
  const changed = (path: string) => ({
    kind: "changed" as const,
    file: { path } as unknown as TFile,
  });
  const failed = (path: string, reason: string) => ({
    kind: "error" as const,
    file: { path } as unknown as TFile,
    reason,
    error: new Error(reason),
  });

  function headingOf(modal: BulkSummaryModal): string | undefined {
    return contentOf(modal).find((e) => e.tag === "h2")?.textContent;
  }

  test("a completed run reads Finished", () => {
    const modal = new BulkSummaryModal(app, [changed("a.md")], {
      aborted: false,
      totalPlanned: 1,
    });
    modal.open();
    expect(headingOf(modal)).toBe("Finished");
  });

  test("a user cancellation reads Cancelled", () => {
    const modal = new BulkSummaryModal(app, [changed("a.md")], {
      aborted: true,
      totalPlanned: 5,
    });
    modal.open();
    expect(headingOf(modal)).toBe("Cancelled");
    expect(contentOf(modal).allText().join(" ")).toContain(
      "4 not processed (cancelled)",
    );
  });

  test("a systemic halt reads Stopped early and says what to fix", () => {
    const modal = new BulkSummaryModal(
      app,
      [failed("a.md", "401 unauthorized")],
      {
        aborted: false,
        halted: { kind: "auth", message: "401", consecutive: 1 },
        totalPlanned: 500,
      },
    );
    modal.open();
    const text = contentOf(modal).allText().join(" ");
    expect(headingOf(modal)).toBe("Stopped early");
    expect(text).toContain("check your API key");
    expect(text).toContain("499 not processed (stopped early)");
  });

  test("a halt outranks the abort flag in the heading", () => {
    const modal = new BulkSummaryModal(app, [failed("a.md", "boom")], {
      aborted: true,
      halted: { kind: "auth", message: "401", consecutive: 1 },
      totalPlanned: 2,
    });
    modal.open();
    expect(headingOf(modal)).toBe("Stopped early");
  });

  test("identical failures collapse to one row", () => {
    const results = Array.from({ length: 300 }, (_, i) =>
      failed(`n${i}.md`, "401 unauthorized"),
    );
    const modal = new BulkSummaryModal(app, results, {
      aborted: false,
      totalPlanned: 300,
    });
    modal.open();
    const text = contentOf(modal).allText().join(" ");
    expect(text).toContain("300 notes: 401 unauthorized");
  });

  test("distinct failures are capped with an overflow row", () => {
    const results = Array.from({ length: 25 }, (_, i) =>
      failed(`n${i}.md`, `distinct failure ${i}`),
    );
    const modal = new BulkSummaryModal(app, results, {
      aborted: false,
      totalPlanned: 25,
    });
    modal.open();
    const text = contentOf(modal).allText().join(" ");
    expect(text).toContain("…and 5 more");
    expect(text).not.toContain("distinct failure 20");
  });
});
