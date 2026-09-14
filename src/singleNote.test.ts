import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { FakeNotice } from "./testDom";

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

const { generateMetadata } = await import("./singleNote");
const { resetClientCache } = await import("./adapters/claude");

beforeEach(() => {
  resetClientCache();
  mockCreate.mockClear();
  FakeNotice.messages.length = 0;
});

function toolUse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", id: "tu_1", name: "submit_metadata", input }],
  };
}

function makeApp(opts: {
  frontmatter?: Record<string, unknown>;
  failWrites?: boolean;
  file?: { extension: string; path: string } | null;
}): App {
  const fm = { ...(opts.frontmatter ?? {}) };
  const file = "file" in opts ? opts.file : { extension: "md", path: "n.md" };
  return {
    workspace: { getActiveFile: () => file },
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
    vault: { cachedRead: async () => "body", read: async () => "body" },
    fileManager: {
      processFrontMatter: async (
        _f: unknown,
        cb: (f: Record<string, unknown>) => void,
      ) => {
        if (opts.failWrites) throw new Error("vault is read-only");
        cb(fm);
      },
    },
  } as unknown as App;
}

const settings = (o: Partial<MetadataToolSettings> = {}) => ({
  ...DEFAULT_SETTINGS,
  anthropicApiKey: "sk-test",
  ...o,
});

// Excludes the transient "Generating metadata..." spinner, which is hidden in
// a finally and is not a message the user is left reading.
const shown = () =>
  FakeNotice.messages.filter((m) => m !== "Generating metadata...");

describe("one write failure is reported once, and named (#239)", () => {
  test("produces exactly one notice, not one per field", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ tags: ["a"], description: "d", title: "T" }),
    );

    await generateMetadata(makeApp({ failWrites: true }), settings());

    // Before the split this read four: one per failed field from inside
    // metadata.ts, plus the wrapper's own.
    expect(shown()).toHaveLength(1);
  });

  test("names the write failure instead of calling it an unexpected error", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ tags: ["a"], description: "d", title: "T" }),
    );

    await generateMetadata(makeApp({ failWrites: true }), settings());

    const message = shown()[0];
    // "Unexpected error" is the wording reserved for ClaudeApiError kind
    // "unknown". Using it here sent the user to check an API key that was fine.
    expect(message).not.toContain("Unexpected error");
    expect(message).toContain("frontmatter");
    expect(message).toContain("vault is read-only");
  });
});

describe("no skip is silent (#237)", () => {
  test("a fully populated note says so instead of nothing", async () => {
    const app = makeApp({
      frontmatter: { tags: ["t"], description: "d", title: "T" },
    });

    await generateMetadata(
      app,
      settings({
        tagsPolicy: "preserve",
        descriptionPolicy: "preserve",
        titlePolicy: "preserve",
      }),
    );

    expect(mockCreate).not.toHaveBeenCalled();
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("already populated");
  });

  // The sharper case: a request went out and was billed, and the old code said
  // nothing at all.
  test("a billed call that writes nothing says the request was billed", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ tags: ["", "  "], description: "   ", title: "" }),
    );

    await generateMetadata(makeApp({}), settings());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("billed");
  });

  test("a missing API key is reported from the typed reason", async () => {
    await generateMetadata(makeApp({}), settings({ anthropicApiKey: "" }));

    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("API key");
  });

  test("a non-markdown file is reported from the typed reason", async () => {
    const app = makeApp({ file: { extension: "pdf", path: "n.pdf" } });

    await generateMetadata(app, settings());

    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("markdown");
  });

  test("no open file still has its own message", async () => {
    await generateMetadata(makeApp({ file: null }), settings());

    expect(shown()).toEqual(["Please open a file first"]);
  });
});
