import { describe, expect, test } from "bun:test";
import type { TFile } from "obsidian";
import { groupErrors } from "./bulkSummaryModal";
import type { FileResult } from "./metadata";

function errorResult(path: string, reason: string): FileResult {
  return {
    kind: "error",
    file: { path } as unknown as TFile,
    reason,
    error: new Error(reason),
  };
}

describe("groupErrors", () => {
  test("collapses identical reasons into one group", () => {
    const groups = groupErrors([
      errorResult("a.md", "401 unauthorized"),
      errorResult("b.md", "401 unauthorized"),
      errorResult("c.md", "401 unauthorized"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("keeps distinct reasons apart, in first-seen order", () => {
    const groups = groupErrors([
      errorResult("a.md", "boom"),
      errorResult("b.md", "different"),
      errorResult("c.md", "boom"),
    ]);
    expect(groups.map((g) => g.reason)).toEqual(["boom", "different"]);
    expect(groups[0].paths).toEqual(["a.md", "c.md"]);
  });

  test("ignores non-error results", () => {
    const results: FileResult[] = [
      { kind: "changed", file: { path: "a.md" } as unknown as TFile },
      {
        kind: "skipped",
        file: { path: "b.md" } as unknown as TFile,
        reason: "no changes",
      },
      errorResult("c.md", "boom"),
    ];
    expect(groupErrors(results)).toEqual([{ reason: "boom", paths: ["c.md"] }]);
  });

  test("returns no groups when nothing failed", () => {
    expect(groupErrors([])).toEqual([]);
  });

  test("a systemic failure over many files collapses to a single row", () => {
    const results = Array.from({ length: 500 }, (_, i) =>
      errorResult(`n${i}.md`, "401 unauthorized"),
    );
    const groups = groupErrors(results);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toHaveLength(500);
  });
});
