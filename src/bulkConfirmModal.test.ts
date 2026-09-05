import { describe, expect, test } from "bun:test";
import { worstCaseApiCalls } from "./bulkConfirmModal";
import { DEFAULT_RETRY_DELAYS_MS } from "./bulkGenerate";

describe("worstCaseApiCalls", () => {
  test("counts the initial request plus the whole retry schedule", () => {
    expect(worstCaseApiCalls(100, [1, 2, 3])).toBe(400);
  });

  test("tracks the production schedule rather than a hard-coded multiplier", () => {
    expect(worstCaseApiCalls(10)).toBe(
      10 * (DEFAULT_RETRY_DELAYS_MS.length + 1),
    );
  });

  test("is the file count itself when nothing is retried", () => {
    expect(worstCaseApiCalls(7, [])).toBe(7);
  });
});
