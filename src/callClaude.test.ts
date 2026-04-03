import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "./settings";

// Mock error classes matching the Anthropic SDK shape
class MockAuthenticationError extends Error {
  name = "AuthenticationError";
}
class MockRateLimitError extends Error {
  name = "RateLimitError";
}
class MockInternalServerError extends Error {
  name = "InternalServerError";
}
class MockAPIError extends Error {
  name = "APIError";
}

const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = MockAuthenticationError;
    static RateLimitError = MockRateLimitError;
    static InternalServerError = MockInternalServerError;
    static APIError = MockAPIError;
  }
  return { default: Anthropic };
});

const { callClaude } = await import("./utils");

const settings = {
  ...DEFAULT_SETTINGS,
  anthropicApiKey: "sk-test-key",
};

describe("callClaude", () => {
  test("returns text content from successful response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"tags": "a,b"}' }],
    });

    const result = await callClaude("system prompt", "user message", settings);
    expect(result).toBe('{"tags": "a,b"}');
  });

  test("throws when response has no text content", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [],
    });

    expect(callClaude("system", "user", settings)).rejects.toThrow(
      "No text content in response",
    );
  });

  test("throws on authentication error", async () => {
    mockCreate.mockRejectedValueOnce(new MockAuthenticationError("bad key"));

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on rate limit error", async () => {
    mockCreate.mockRejectedValueOnce(new MockRateLimitError("rate limited"));

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on internal server error", async () => {
    mockCreate.mockRejectedValueOnce(new MockInternalServerError("overloaded"));

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on generic API error", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIError("something else"));

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on unknown error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network failure"));

    expect(callClaude("system", "user", settings)).rejects.toThrow(
      "network failure",
    );
  });

  test("passes system message and user message to API", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "response" }],
    });

    await callClaude("my system prompt", "my user message", settings);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "my system prompt",
        messages: [{ role: "user", content: "my user message" }],
        model: settings.anthropicModel,
        max_tokens: 2048,
      }),
    );
  });
});
