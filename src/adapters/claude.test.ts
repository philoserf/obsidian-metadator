import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS, type MetadataField } from "../settings";

// Mock error classes matching the Anthropic SDK shape
class MockAuthenticationError extends Error {
  override name = "AuthenticationError";
}
class MockRateLimitError extends Error {
  override name = "RateLimitError";
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
  override name = "InternalServerError";
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
  override name = "APIError";
}
// Mirrors the SDK: APIConnectionTimeoutError extends APIConnectionError
// extends APIError, so classifyError must test this one first.
class MockAPIConnectionError extends MockAPIError {
  override name = "APIConnectionError";
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
  buildToolSchema,
  callClaudeForMetadata,
  ClaudeApiError,
  resetClientCache,
  usesAutoToolChoice,
  validateMetadataInput,
} = await import("./claude");

const settings = {
  ...DEFAULT_SETTINGS,
  anthropicApiKey: "sk-test-key",
};
// claude.ts caches one Anthropic client per API key for the whole run, while
// mock.module is per-file. These suites use colliding keys, so without this a
// client built under another file's mocked SDK gets served here and its
// messages.create belongs to that file's mock.
beforeEach(() => {
  resetClientCache();
});

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
      toolUseResponse({ description: 123, title: "t" }),
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
    mockCreate.mockResolvedValueOnce(toolUseResponse({ title: "t" }));

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
    mockCreate.mockResolvedValueOnce(toolUseResponse({ description: "d" }));

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

  // With enableTitle off, buildToolSchema does not declare `title`, so a model
  // that volunteers one is off-schema. Validating it anyway turned a non-string
  // into a thrown error that discarded the description that arrived
  // correctly — a failure mode invented by validating an unwanted field (#250).
  test("ignores an off-schema title instead of failing the generation", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ description: "d", title: 42 }),
    );

    const result = await callClaudeForMetadata("s", "u", {
      ...settings,
      enableTitle: false,
    });

    expect(result.description).toBe("d");
    expect(result.title).toBeUndefined();
  });

  test("forces the submit_metadata tool and includes a title field when enabled", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ description: "d", title: "t" }),
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
              required: expect.arrayContaining(["description", "title"]),
            }),
          }),
        ]),
      }),
      expect.any(Object),
    );
  });

  test("omits title from required when enableTitle is false", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ description: "d" }));

    await callClaudeForMetadata("system", "user", {
      ...settings,
      enableTitle: false,
    });

    const call = mockCreate.mock.calls.at(-1);
    const body = call?.[0] as {
      tools: { input_schema: { required: string[] } }[];
    };
    expect(body.tools[0]?.input_schema.required).toEqual(["description"]);
  });

  test("sets an explicit request timeout", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ description: "d", title: "t" }),
    );

    await callClaudeForMetadata("system", "user", settings);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  test("passes abort signal when provided", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ description: "d", title: "t" }),
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

describe("tool_choice by model family", () => {
  function lastRequest(): Record<string, unknown> {
    const call = mockCreate.mock.calls.at(-1);
    return (call as unknown[])[0] as Record<string, unknown>;
  }

  test("forces the metadata tool on models that support it", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ description: "d", title: "t" }),
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
      toolUseResponse({ description: "d", title: "t" }),
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
    expect(usesAutoToolChoice("claude-opus-5-5")).toBe(true);
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
          input: { description: "d", title: "T" },
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
          input: { description: "d", title: "T" },
        },
      ],
    });

    const result = await callClaudeForMetadata("system", "user", settings);
    expect(result.description).toBe("d");
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
      override name = "APIConnectionTimeoutError";
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

describe("client caching (#207)", () => {
  test("reuses one client across calls with the same key", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    let constructed = 0;
    const Counting = new Proxy(Anthropic as never, {
      construct(target, args) {
        constructed++;
        return Reflect.construct(target as never, args);
      },
    });
    mock.module("@anthropic-ai/sdk", () => ({ default: Counting }));
    resetClientCache();

    // Once-per-call rather than a sticky default, so this queue cannot leak
    // into any test added after this one.
    const ok = () => toolUseResponse({ description: "d", title: "T" });
    mockCreate
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    await callClaudeForMetadata("system", "user", settings);
    await callClaudeForMetadata("system", "user", settings);
    await callClaudeForMetadata("system", "user", settings);

    expect(constructed).toBe(1);
  });

  test("rebuilds when the API key changes, so a settings edit takes effect", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const keys: string[] = [];
    const Recording = new Proxy(Anthropic as never, {
      construct(target, args) {
        keys.push((args[0] as { apiKey: string }).apiKey);
        return Reflect.construct(target as never, args);
      },
    });
    mock.module("@anthropic-ai/sdk", () => ({ default: Recording }));
    resetClientCache();

    const ok = () => toolUseResponse({ description: "d", title: "T" });
    mockCreate.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    await callClaudeForMetadata("system", "user", settings);
    await callClaudeForMetadata("system", "user", {
      ...settings,
      anthropicApiKey: "sk-different",
    });

    expect(keys).toEqual(["sk-test-key", "sk-different"]);
  });
});

// A disabled field is not asked for: absent from the schema's properties and
// from `required`, so the model has nothing to fill in (#305).
describe("buildToolSchema and validateMetadataInput per enabled-field subset", () => {
  const ALL: MetadataField[] = ["description", "title"];
  const subsets: MetadataField[][] = [];
  for (let mask = 1; mask < 1 << ALL.length; mask++) {
    subsets.push(ALL.filter((_, i) => mask & (1 << i)));
  }
  const full = { description: "d", title: "t" };

  for (const subset of subsets) {
    const label = subset.join("+");

    test(`schema declares and requires exactly ${label}`, () => {
      const schema = buildToolSchema(
        new Set(subset),
        DEFAULT_SETTINGS,
      ).input_schema;
      expect(Object.keys(schema.properties).sort()).toEqual([...subset].sort());
      expect([...schema.required].sort()).toEqual([...subset].sort());
    });

    test(`validation returns exactly ${label} and ignores the rest`, () => {
      const out = validateMetadataInput(
        full,
        new Set(subset),
        DEFAULT_SETTINGS,
      );
      expect(Object.keys(out).sort()).toEqual([...subset].sort());
    });

    test(`validation requires each of ${label}`, () => {
      for (const missing of subset) {
        const input: Record<string, unknown> = { ...full };
        delete input[missing];
        expect(() =>
          validateMetadataInput(input, new Set(subset), DEFAULT_SETTINGS),
        ).toThrow(`'${missing}'`);
      }
    });
  }

  test("a malformed disabled field does not fail the generation", () => {
    const out = validateMetadataInput(
      { description: 7, title: "t" },
      new Set<MetadataField>(["title"]),
      DEFAULT_SETTINGS,
    );
    expect(out).toEqual({ title: "t" });
  });

  // #308: a choice field is an enum of its values plus "" for none, and
  // never fails a generation — none, missing and off-list all write nothing.
  describe("a choice field", () => {
    const eyebrow = new Set<MetadataField>(["description", "eyebrow"]);

    test("is declared as an enum of its values plus the empty answer", () => {
      const { properties, required } = buildToolSchema(
        eyebrow,
        DEFAULT_SETTINGS,
      ).input_schema;
      expect(properties.eyebrow?.enum).toEqual([
        "Poem",
        "Fiction",
        "Quotation",
        "",
      ]);
      expect(properties.description?.enum).toBeUndefined();
      expect(required).toContain("eyebrow");
    });

    test("keeps a listed value", () => {
      expect(
        validateMetadataInput(
          { description: "d", eyebrow: "Poem" },
          eyebrow,
          DEFAULT_SETTINGS,
        ),
      ).toEqual({ description: "d", eyebrow: "Poem" });
    });

    test("drops none, a missing value and an off-list value, keeping the rest", () => {
      for (const input of [
        { description: "d", eyebrow: "" },
        { description: "d" },
        { description: "d", eyebrow: "Essay" },
        { description: "d", eyebrow: "poem" },
        { description: "d", eyebrow: 3 },
      ]) {
        expect(validateMetadataInput(input, eyebrow, DEFAULT_SETTINGS)).toEqual(
          { description: "d" },
        );
      }
    });

    test("takes its list from the settings", () => {
      const settings = { eyebrowValues: ["Letter"] };
      expect(
        buildToolSchema(eyebrow, settings).input_schema.properties.eyebrow
          ?.enum,
      ).toEqual(["Letter", ""]);
      expect(
        validateMetadataInput(
          { description: "d", eyebrow: "Poem" },
          eyebrow,
          settings,
        ),
      ).toEqual({ description: "d" });
    });
  });

  test("callClaudeForMetadata sends the schema the settings enable", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ description: "d" }));

    const result = await callClaudeForMetadata("s", "u", {
      ...settings,
      enableTitle: false,
    });

    const body = mockCreate.mock.calls.at(-1)?.[0] as {
      tools: {
        input_schema: { properties: object; required: string[] };
      }[];
    };
    expect(body.tools[0]?.input_schema.required).toEqual(["description"]);
    expect(Object.keys(body.tools[0]?.input_schema.properties ?? {})).toEqual([
      "description",
    ]);
    expect(result).toEqual({ description: "d" });
  });
});
