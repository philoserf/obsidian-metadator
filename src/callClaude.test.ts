import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "./settings";

// Mock the Anthropic SDK before importing callClaude
const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class AuthenticationError extends Error {
    name = "AuthenticationError";
  }
  class RateLimitError extends Error {
    name = "RateLimitError";
  }
  class InternalServerError extends Error {
    name = "InternalServerError";
  }
  class APIError extends Error {
    name = "APIError";
  }

  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static InternalServerError = InternalServerError;
    static APIError = APIError;
  }

  return { default: Anthropic };
});

// Import after mocking
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
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    mockCreate.mockRejectedValueOnce(
      new Anthropic.AuthenticationError("bad key"),
    );

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on rate limit error", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    mockCreate.mockRejectedValueOnce(
      new Anthropic.RateLimitError("rate limited"),
    );

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on internal server error", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    mockCreate.mockRejectedValueOnce(
      new Anthropic.InternalServerError("overloaded"),
    );

    expect(callClaude("system", "user", settings)).rejects.toThrow();
  });

  test("throws on generic API error", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    mockCreate.mockRejectedValueOnce(new Anthropic.APIError("something else"));

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
