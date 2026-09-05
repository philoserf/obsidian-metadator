import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "./settings";

// Mock error classes matching the Anthropic SDK shape
class MockAuthenticationError extends Error {
  name = "AuthenticationError";
}
class MockRateLimitError extends Error {
  name = "RateLimitError";
  headers?: { get(name: string): string | null };
  constructor(message?: string, headers?: Record<string, string>) {
    super(message);
    if (headers) {
      this.headers = {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      };
    }
  }
}
class MockInternalServerError extends Error {
  name = "InternalServerError";
  headers?: { get(name: string): string | null };
  constructor(message?: string, headers?: Record<string, string>) {
    super(message);
    if (headers) {
      this.headers = {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      };
    }
  }
}
class MockAPIError extends Error {
  name = "APIError";
}
// Mirrors the SDK: APIConnectionTimeoutError extends APIConnectionError
// extends APIError, so classifyError must test this one first.
class MockAPIConnectionError extends MockAPIError {
  name = "APIConnectionError";
}

const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = MockAuthenticationError;
    static RateLimitError = MockRateLimitError;
    static InternalServerError = MockInternalServerError;
    static APIError = MockAPIError;
    static APIConnectionError = MockAPIConnectionError;
  }
  return { default: Anthropic };
});

const {
  callClaudeForMetadata,
  ClaudeApiError,
  parseRetryAfterMs,
  usesAutoToolChoice,
} = await import("./adapters/claude");

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
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: 123, description: "d", title: "t" }),
    );

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
  });

  test("rejects tool input that omits a required field", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ tags: "a,b" }));

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
    expect((caught as Error).message).toMatch(/description/);
  });

  test("rejects tool input that omits title when enableTitle is true", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d" }),
    );

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
    expect((caught as Error).message).toMatch(/title/);
  });

  test("throws when model calls a different tool", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          id: "tu_2",
          name: "some_other_tool",
          input: { foo: "bar" },
        },
      ],
    });

    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).kind).toBe("api");
    expect((caught as Error).message).toMatch(/some_other_tool/);
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

  test("threads Retry-After header through ClaudeApiError on rate-limit", async () => {
    mockCreate.mockRejectedValueOnce(
      new MockRateLimitError("rate limited", { "retry-after": "3" }),
    );
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).retryAfterMs).toBe(
      3000,
    );
  });

  test("threads Retry-After header through ClaudeApiError on overloaded", async () => {
    mockCreate.mockRejectedValueOnce(
      new MockInternalServerError("overloaded", { "retry-after": "10" }),
    );
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect((caught as InstanceType<typeof ClaudeApiError>).retryAfterMs).toBe(
      10_000,
    );
  });

  test("leaves retryAfterMs undefined when header is absent", async () => {
    mockCreate.mockRejectedValueOnce(new MockRateLimitError("rate limited"));
    let caught: unknown;
    try {
      await callClaudeForMetadata("s", "u", settings);
    } catch (e) {
      caught = e;
    }
    expect(
      (caught as InstanceType<typeof ClaudeApiError>).retryAfterMs,
    ).toBeUndefined();
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

describe("parseRetryAfterMs", () => {
  function makeHeaders(values: Record<string, string>) {
    return {
      get: (name: string) => values[name.toLowerCase()] ?? null,
    };
  }

  test("parses integer seconds", () => {
    expect(parseRetryAfterMs(makeHeaders({ "retry-after": "5" }))).toBe(5000);
  });

  test("parses fractional seconds", () => {
    expect(parseRetryAfterMs(makeHeaders({ "retry-after": "0.5" }))).toBe(500);
  });

  test("returns undefined when header is absent", () => {
    expect(parseRetryAfterMs(makeHeaders({}))).toBeUndefined();
  });

  test("returns undefined when headers is undefined", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  test("returns undefined for HTTP-date form (not parsed)", () => {
    expect(
      parseRetryAfterMs(
        makeHeaders({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      ),
    ).toBeUndefined();
  });

  test("returns undefined for negative values", () => {
    expect(parseRetryAfterMs(makeHeaders({ "retry-after": "-1" }))).toBe(
      undefined,
    );
  });
});

describe("tool_choice by model family", () => {
  function lastRequest(): Record<string, unknown> {
    const call = mockCreate.mock.calls.at(-1);
    return (call as unknown[])[0] as Record<string, unknown>;
  }

  test("forces the metadata tool on models that support it", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d", title: "t" }),
    );
    await callClaudeForMetadata("system prompt", "u", {
      ...settings,
      anthropicModel: "claude-sonnet-5",
    });

    const req = lastRequest();
    expect(req.tool_choice).toEqual({ type: "tool", name: "submit_metadata" });
    expect(req.system).toBe("system prompt");
    expect(req.output_config).toBeUndefined();
  });

  test("uses auto tool_choice plus an instruction on the fable family", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a", description: "d", title: "t" }),
    );
    await callClaudeForMetadata("system prompt", "u", {
      ...settings,
      anthropicModel: "claude-fable-5-1",
    });

    const req = lastRequest();
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.system).toContain("system prompt");
    expect(req.system).toContain("submit_metadata");
    expect(req.output_config).toEqual({ effort: "low" });
    // Thinking tokens share the output budget, so this path needs more room.
    expect(req.max_tokens).toBeGreaterThan(2048);
  });

  test("recognizes unreleased members of the auto families", () => {
    expect(usesAutoToolChoice("claude-fable-5-2")).toBe(true);
    expect(usesAutoToolChoice("claude-fable-6")).toBe(true);
    expect(usesAutoToolChoice("claude-mythos-5-1")).toBe(true);
    expect(usesAutoToolChoice("claude-opus-5")).toBe(false);
    expect(usesAutoToolChoice("claude-sonnet-5")).toBe(false);
    expect(usesAutoToolChoice("claude-haiku-4-5")).toBe(false);
  });
});

describe("truncated responses (#174)", () => {
  test("rejects a response stopped at the token limit", async () => {
    // The tool call is otherwise well formed — this is exactly the case that
    // slipped through, since validateMetadataInput only checks types.
    mockCreate.mockResolvedValueOnce({
      stop_reason: "max_tokens",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: {
            tags: "ai,testing",
            description: "A description cut off mid-sen",
            title: "A Title",
          },
        },
      ],
    });

    await expect(
      callClaudeForMetadata("system", "user", settings),
    ).rejects.toMatchObject({ kind: "api" });
  });

  test("a normal stop_reason passes through", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "ai", description: "d", title: "T" },
        },
      ],
    });

    const result = await callClaudeForMetadata("system", "user", settings);
    expect(result.description).toBe("d");
  });

  test("an absent stop_reason is not treated as truncation", async () => {
    // No existing fixture sets stop_reason, so undefined has to stay valid.
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "ai", description: "d", title: "T" },
        },
      ],
    });

    const result = await callClaudeForMetadata("system", "user", settings);
    expect(result.tags).toBe("ai");
  });
});

describe("connection error classification (#180)", () => {
  test("a connection error is its own kind, not generic api", async () => {
    // The trap this guards: APIConnectionError extends APIError, so a
    // classifier that tests APIError first makes this kind unreachable.
    mockCreate.mockRejectedValueOnce(
      new MockAPIConnectionError("Connection error."),
    );

    await expect(
      callClaudeForMetadata("system", "user", settings),
    ).rejects.toMatchObject({ kind: "connection" });
  });

  test("a timeout subclass classifies as connection too", async () => {
    class MockTimeout extends MockAPIConnectionError {
      name = "APIConnectionTimeoutError";
    }
    mockCreate.mockRejectedValueOnce(new MockTimeout("Request timed out."));

    await expect(
      callClaudeForMetadata("system", "user", settings),
    ).rejects.toMatchObject({ kind: "connection" });
  });

  test("a plain API error is still api", async () => {
    mockCreate.mockRejectedValueOnce(new MockAPIError("bad request"));

    await expect(
      callClaudeForMetadata("system", "user", settings),
    ).rejects.toMatchObject({ kind: "api" });
  });
});
