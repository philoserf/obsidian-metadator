import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";

// Mock Anthropic SDK to return controlled responses
const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = class extends Error {};
    static RateLimitError = class extends Error {};
    static InternalServerError = class extends Error {};
    static APIError = class extends Error {};
  }
  return { default: Anthropic };
});

// Import after mocking
const { generateMetadata, generateMetadataForFile } = await import(
  "./metadata"
);

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

function makeApp(opts: {
  file?: { extension: string } | null;
  frontmatter?: Record<string, unknown>;
  content?: string;
  // Number of leading processFrontMatter calls that should throw, simulating a
  // vault that has become unwritable. Writes go in `updates` order: tags,
  // description, title.
  failWrites?: number;
  // When true, metadataCache hands back a *copy* of the frontmatter, the way
  // the real cache hands back its own parsed object rather than the one
  // processFrontMatter will later mutate. Needed to reproduce #178, where a
  // write decision made from the cached copy is applied to live data.
  snapshotCache?: boolean;
}): { app: App; fm: Record<string, unknown> } {
  const fm = { ...(opts.frontmatter ?? {}) };
  const file = "file" in opts ? opts.file : { extension: "md" };
  let writeCalls = 0;

  const app = {
    workspace: {
      getActiveFile: () => file,
    },
    metadataCache: {
      getFileCache: () => ({
        frontmatter: opts.snapshotCache ? { ...fm } : fm,
      }),
    },
    vault: {
      read: async () => opts.content ?? "Some article content for testing.",
      cachedRead: async () =>
        opts.content ?? "Some article content for testing.",
    },
    fileManager: {
      processFrontMatter: async (
        _file: unknown,
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        if (writeCalls++ < (opts.failWrites ?? 0)) {
          throw new Error("vault is read-only");
        }
        fn(fm);
      },
    },
  } as unknown as App;

  return { app, fm, writes: () => writeCalls };
}

function makeFile(path = "note.md"): { path: string; extension: string } {
  return { path, extension: "md" };
}

function makeSettings(
  overrides: Partial<MetadataToolSettings> = {},
): MetadataToolSettings {
  return {
    ...DEFAULT_SETTINGS,
    anthropicApiKey: "sk-test-key",
    ...overrides,
  };
}

describe("generateMetadata integration", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test("full flow: generates and writes tags, description, and title", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "ai,testing",
        description: "A test article",
        title: "Test Title",
      }),
    );

    const { app, fm } = makeApp({});
    const settings = makeSettings();

    await generateMetadata(app, settings);

    expect(fm.tags).toEqual(["ai", "testing"]);
    expect(fm.description).toBe("A test article");
    expect(fm.title).toBe("Test Title");
  });

  test("skips when no file is open", async () => {
    const { app } = makeApp({ file: null });
    const settings = makeSettings();

    // Should not throw, just show notice
    await generateMetadata(app, settings);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("skips non-markdown files", async () => {
    const { app } = makeApp({ file: { extension: "pdf" } });
    const settings = makeSettings();

    await generateMetadata(app, settings);
    // mockCreate should not be called for non-markdown
  });

  test("skips when API key is missing", async () => {
    const { app } = makeApp({});
    const settings = makeSettings({ anthropicApiKey: "" });

    await generateMetadata(app, settings);
    // Should not call API without a key
  });

  test("preserve_existing skips populated fields", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "new-tag",
        description: "new desc",
        title: "New Title",
      }),
    );

    const { app, fm } = makeApp({
      frontmatter: {
        tags: ["existing-tag"],
        description: "existing desc",
      },
    });
    const settings = makeSettings({ updateMethod: "preserve_existing" });

    await generateMetadata(app, settings);

    // Tags should be kept (not appended) since preserve_existing
    expect(fm.tags).toEqual(["existing-tag"]);
    // Description should be kept
    expect(fm.description).toBe("existing desc");
    // Title was empty, so it gets populated
    expect(fm.title).toBe("New Title");
  });

  test("always_regenerate updates all fields", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "new-tag",
        description: "new desc",
        title: "New Title",
      }),
    );

    const { app, fm } = makeApp({
      frontmatter: {
        tags: ["old-tag"],
        description: "old desc",
        title: "Old Title",
      },
    });
    const settings = makeSettings({ updateMethod: "always_regenerate" });

    await generateMetadata(app, settings);

    expect(fm.tags).toEqual(["old-tag", "new-tag"]);
    expect(fm.description).toBe("new desc");
    expect(fm.title).toBe("New Title");
  });

  test("strips surrounding quotes from generated title before writing", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "a,b",
        description: "desc",
        title: '"Quoted Title"',
      }),
    );

    const { app, fm } = makeApp({});
    await generateMetadata(app, makeSettings());

    expect(fm.title).toBe("Quoted Title");
  });

  test("does not generate title when enableTitle is false", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a,b", description: "desc" }),
    );

    const { app, fm } = makeApp({});
    const settings = makeSettings({ enableTitle: false });

    await generateMetadata(app, settings);

    expect(fm.tags).toEqual(["a", "b"]);
    expect(fm.description).toBe("desc");
    expect(fm.title).toBeUndefined();
  });

  test("passes abort signal to API call when provided", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "a,b", description: "desc", title: "T" }),
    );
    const controller = new AbortController();
    const { app } = makeApp({});

    await generateMetadata(app, makeSettings(), { signal: controller.signal });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  test("skips when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("plugin_unloaded");
    const { app, fm } = makeApp({});

    await generateMetadata(app, makeSettings(), { signal: controller.signal });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(fm.tags).toBeUndefined();
    expect(fm.description).toBeUndefined();
    expect(fm.title).toBeUndefined();
  });

  test("returns error result with ClaudeApiError when model returns no tool_use block", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "I refuse to use the tool.",
        },
      ],
    });

    const { app, fm } = makeApp({});
    const file = makeFile();

    const result = await generateMetadataForFile(
      app,
      file as never,
      makeSettings(),
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect((result.error as Error).name).toBe("ClaudeApiError");
    }
    expect(fm.tags).toBeUndefined();
    expect(fm.description).toBeUndefined();
  });

  test("maps abort rejection to skipped result", async () => {
    mockCreate.mockImplementationOnce(
      (_body: unknown, requestOpts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (requestOpts.signal?.aborted) {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
            return;
          }
          requestOpts.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const { app } = makeApp({});
    const file = makeFile();

    const run = generateMetadataForFile(app, file as never, makeSettings(), {
      signal: controller.signal,
    });
    controller.abort("plugin_unloaded");

    const result = await run;
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("cancelled");
    }
  });
});

describe("concurrent edits during the API call (#178)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test("preserve_existing does not overwrite a field the user filled in mid-request", async () => {
    const { app, fm } = makeApp({ frontmatter: {}, snapshotCache: true });

    // The note is empty when the request starts, so the pre-call snapshot says
    // "description is empty, safe to write". While the request is in flight the
    // user types a description into the open note.
    mockCreate.mockImplementationOnce(async () => {
      fm.description = "what the user typed";
      return toolUseResponse({
        tags: "ai,testing",
        description: "what Claude generated",
        title: "Generated Title",
      });
    });

    await generateMetadata(app, makeSettings());

    expect(fm.description).toBe("what the user typed");
    // Fields the user did not touch are still filled in.
    expect(fm.title).toBe("Generated Title");
    expect(fm.tags).toEqual(["ai", "testing"]);
  });

  test("preserve_existing does not open the file for a field it is keeping", async () => {
    // processFrontMatter serializes and writes the file back on every call,
    // whether or not the callback mutates anything. Calling it for a field we
    // have already decided to leave alone cost an mtime bump and a vault
    // modify event per skipped field, per file (#185).
    //
    // tags is empty so generation still runs; description and title are
    // populated, so under preserve_existing they resolve to keep. Exactly one
    // write should reach the file — before the fix there were three.
    const { app, writes } = makeApp({
      frontmatter: {
        description: "existing description",
        title: "Existing Title",
      },
      snapshotCache: true,
    });

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "ai,testing",
        description: "generated",
        title: "Generated",
      }),
    );

    await generateMetadata(app, makeSettings());

    expect(writes()).toBe(1);
  });

  test("preserve_existing keeps a field whose value is 0 or false", async () => {
    // Falsy but present. isEmptyValue used to report both as empty, so
    // shouldGenerate sent the note to the API and the update_if_empty re-check
    // then overwrote the very values it exists to protect (#201).
    const { app, fm } = makeApp({
      frontmatter: { description: 0, title: false },
      snapshotCache: true,
    });

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "ai,testing",
        description: "what Claude generated",
        title: "Generated Title",
      }),
    );

    await generateMetadata(app, makeSettings());

    expect(fm.description).toBe(0);
    expect(fm.title).toBe(false);
  });

  test("always_regenerate still overwrites, since the user asked for it", async () => {
    const { app, fm } = makeApp({ frontmatter: {}, snapshotCache: true });

    mockCreate.mockImplementationOnce(async () => {
      fm.description = "what the user typed";
      return toolUseResponse({
        tags: "ai",
        description: "what Claude generated",
        title: "Generated Title",
      });
    });

    await generateMetadata(
      app,
      makeSettings({ updateMethod: "always_regenerate" }),
    );

    expect(fm.description).toBe("what Claude generated");
  });
});

describe("failed frontmatter writes (#187)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test("all writes failing reports an error, not a skip", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "ai",
        description: "A test article",
        title: "Test Title",
      }),
    );
    const { app, fm } = makeApp({ failWrites: 3 });

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect(result.kind).toBe("error");
    expect(fm.description).toBeUndefined();
    if (result.kind === "error") {
      expect(result.reason).toContain("failed to write frontmatter");
      expect(result.reason).toContain("tags");
      expect(result.reason).not.toContain("other fields were written");
    }
  });

  test("a partial write failure is still reported as an error", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: "ai",
        description: "A test article",
        title: "Test Title",
      }),
    );
    const { app, fm } = makeApp({ failWrites: 1 });

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect(result.kind).toBe("error");
    expect(fm.description).toBe("A test article");
    if (result.kind === "error") {
      expect(result.reason).toContain("other fields were written");
    }
  });

  test("an all-punctuation tags string writes nothing and reports no change", async () => {
    // "," is a non-empty string, so it passed validateMetadataInput and the
    // truthiness guard, but parseTags reduces it to []. That empty array was
    // written as `tags: []` and reported as a change (#161).
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: " , ", description: "", title: "" }),
    );
    const { app, fm, writes } = makeApp({});

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect("tags" in fm).toBe(false);
    expect(writes()).toBe(0);
    expect(result.kind).toBe("skipped");
  });

  test("a genuine no-op is still reported as skipped", async () => {
    // The model returned nothing usable, so no write is even attempted — the
    // case "skipped: no changes" is supposed to describe.
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: "", description: "", title: "" }),
    );
    const { app } = makeApp({});

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("no changes");
    }
  });
});
