import { beforeEach, describe, expect, mock, test } from "bun:test";

// The SDK is mocked here for the same reason as elsewhere: computeDelayMs
// branches on `error instanceof ClaudeApiError`, and ClaudeApiError's module
// imports the SDK.
const mockCreate = mock();
mock.module("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = class extends Error {};
    static RateLimitError = class extends Error {};
    static InternalServerError = class extends Error {};
    static APIError = APIError;
    static APIConnectionError = class extends APIError {};
  }
  return { default: Anthropic };
});

const { computeDelayMs } = await import("./retryPolicy");
const { ClaudeApiError, resetClientCache } = await import("./adapters/claude");
beforeEach(() => {
  resetClientCache();
});

describe("computeDelayMs", () => {
  test("applies low-end jitter (random=0 → 0.5x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0)).toBe(500);
  });

  test("applies high-end jitter (random≈1 → ~1.5x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0.999)).toBe(1499);
  });

  test("applies mid-range jitter (random=0.5 → 1.0x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0.5)).toBe(1000);
  });

  test("returns 0 when base delay is 0 (zero-delay tests stay deterministic)", () => {
    expect(computeDelayMs(0, undefined, () => 0.7)).toBe(0);
  });

  test("ignores non-ClaudeApiError values when computing jitter", () => {
    expect(computeDelayMs(1000, new Error("plain"), () => 0)).toBe(500);
  });

  test("honors retryAfterMs from a ClaudeApiError when provided", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 800);
    expect(computeDelayMs(1000, err, () => 0)).toBe(800);
  });

  test("caps retryAfterMs at 2x base to avoid stalling the bulk loop", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 60_000);
    expect(computeDelayMs(1000, err, () => 0)).toBe(2000);
  });

  test("honors retryAfterMs of 0 (server says retry immediately)", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 0);
    expect(computeDelayMs(1000, err, () => 0.999)).toBe(0);
  });

  test("falls back to jitter when retryAfterMs is undefined on a ClaudeApiError", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited");
    expect(computeDelayMs(1000, err, () => 0)).toBe(500);
  });
});
