import { describe, expect, test } from "bun:test";
import { REQUESTS_PER_ATTEMPT } from "./adapters/claude";
import { worstCaseApiCalls } from "./bulkConfirmModal";
import { DEFAULT_RETRY_DELAYS_MS } from "./bulkGenerate";

describe("worstCaseApiCalls", () => {
  test("counts the bulk retry schedule and the SDK's own retries", () => {
    expect(worstCaseApiCalls(100, [1, 2, 3])).toBe(400 * REQUESTS_PER_ATTEMPT);
  });

  test("tracks the production constants rather than hard-coded multipliers", () => {
    expect(worstCaseApiCalls(10)).toBe(
      10 * (DEFAULT_RETRY_DELAYS_MS.length + 1) * REQUESTS_PER_ATTEMPT,
    );
  });

  test("still counts the SDK retries when the bulk schedule is empty", () => {
    expect(worstCaseApiCalls(7, [])).toBe(7 * REQUESTS_PER_ATTEMPT);
  });
});
