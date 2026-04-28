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

const { callClaudeForMetadata, ClaudeApiError } = await import(
  "./adapters/claude"
);

const settings = {
  ...DEFAULT_SETTINGS,
  anthropicApiKey: "sk-test-key",
};

function toolUseResponse(input: Record<string, unknown>) {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "submit_metadata",
        input,
      },
    ],
  };
}

describe("callClaudeForMetadata", () => {
  test("returns parsed tool input from successful response", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "a,b",
        description: "summary",
        title: "Test",
      }),
    );

    const result = await callClaudeForMetadata(
      "system prompt",
      "user message",
      settings,
    );
    expect(result).toEqual({
      tags: "a,b",
      description: "summary",
      title: "Test",
    });
  });

  test("throws ClaudeApiError(api) when no tool_use block is returned", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I refuse to use the tool." }],
    });

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
  });

  test("rejects tool input that has the wrong field types", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ tags: 123 }));

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
  });

  test("maps authentication error to kind:auth", async () => {
    mockCreate.mockRejectedValueOnce(new MockAuthenticationError("bad key"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("auth");
  });

  test("maps rate-limit error to kind:rate_limit", async () => {
    mockCreate.mockRejectedValueOnce(new MockRateLimitError("rate limited"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe(
      "rate_limit",
    );
  });

  test("maps internal-server error to kind:overloaded", async () => {
    mockCreate.mockRejectedValueOnce(new MockInternalServerError("overloaded"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe(
      "overloaded",
    );
  });

  test("maps generic API error to kind:api", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIError("something else"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
  });

  test("maps unknown error to kind:unknown", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network failure"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe(
      "unknown",
    );
  });

  test("re-throws AbortError without wrapping", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    mockCreate.mockRejectedValueOnce(abort);

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(abort);
    expect(caught).not.toBeInstanceOf(ClaudeApiError);
  });

  test("forces the submit_metadata tool and includes a title field when enabled", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d", title: "t" }),
    );

    await callClaudeForMetadata("system", "user", settings);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "system",
        messages: [{ role: "user", content: "user" }],
        model: settings.anthropicModel,
        max_tokens: 2048,
        tool_choice: { type: "tool", name: "submit_metadata" },
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "submit_metadata",
            input_schema: expect.objectContaining({
              required: expect.arrayContaining([
                "tags",
                "description",
                "title",
              ]),
            }),
          }),
        ]),
      }),
      expect.any(Object),
    );
  });

  test("omits title from required when enableTitle is false", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d" }),
    );

    await callClaudeForMetadata("system", "user", {
      ...settings,
      enableTitle: false,
    });

    const call = mockCreate.mock.calls.at(-1);
    const body = call?.[0] as {
      tools: { input_schema: { required: string[] } }[];
    };
    expect(body.tools[0].input_schema.required).toEqual([
      "tags",
      "description",
    ]);
  });

  test("sets an explicit request timeout", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d", title: "t" }),
    );

    await callClaudeForMetadata("system", "user", settings);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  test("passes abort signal when provided", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d", title: "t" }),
    );
    const controller = new AbortController();

    await callClaudeForMetadata("system", "user", settings, {
      signal: controller.signal,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
