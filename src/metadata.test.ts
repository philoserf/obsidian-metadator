import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";

// Mock Anthropic SDK to return controlled responses
const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = class extends Error {};
    static RateLimitError = class extends Error {};
    static InternalServerError = class extends Error {};
    static APIError = APIError;
    // classifyError checks this before APIError; leaving it undefined makes
    // `instanceof undefined` throw from inside the adapter.
    static APIConnectionError = class extends APIError {};
  }
  return { default: Anthropic };
});

// Import after mocking. stripSurroundingQuotes comes through here too rather
// than as a static import: a static one hoists above the mock.module call
// above, loading metadata.ts -> adapters/claude.ts -> the real SDK before the
// mock is installed.
const { generateMetadataForFile, stripSurroundingQuotes } = await import(
  "./metadata"
);
// The interactive wrapper is singleNote.ts's, but these suites assert on
// frontmatter outcomes rather than on notices, so they reach metadata.ts
// through it. The notice behavior itself is covered in singleNote.test.ts.
const { generateMetadata } = await import("./singleNote");
const { resetClientCache } = await import("./adapters/claude");
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
}): { app: App; fm: Record<string, unknown>; writes: () => number } {
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

// The #178 live re-check is what `preserve` does; these suites used to get it
// from the old global preserve_existing default.
const PRESERVE_ALL = {
  tagsPolicy: "preserve",
  descriptionPolicy: "preserve",
  titlePolicy: "preserve",
} as const;

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
        tags: ["ai", "testing"],
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
        tags: ["new-tag"],
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
    const settings = makeSettings({
      tagsPolicy: "preserve",
      descriptionPolicy: "preserve",
      titlePolicy: "preserve",
    });

    await generateMetadata(app, settings);

    // Tags should be kept (not appended) since preserve_existing
    expect(fm.tags).toEqual(["existing-tag"]);
    // Description should be kept
    expect(fm.description).toBe("existing desc");
    // Title was empty, so it gets populated
    expect(fm.title).toBe("New Title");
  });

  // The predecessor of this test was named "always_regenerate updates all
  // fields" and asserted tags === ["old-tag", "new-tag"] — a merge, under a
  // name promising an overwrite. That mismatch is exactly what #230 reported,
  // and it stayed invisible because the name described the documented
  // behavior while the assertion pinned the real one.
  test("regenerate replaces the tag list instead of growing it (#230)", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: ["new-tag"],
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
    const settings = makeSettings({
      tagsPolicy: "regenerate",
      descriptionPolicy: "regenerate",
      titlePolicy: "regenerate",
    });

    await generateMetadata(app, settings);

    // "old-tag" is gone — under the old append this was impossible, which is
    // why a sprawling tag list could not be cleaned from the settings tab.
    expect(fm.tags).toEqual(["new-tag"]);
    expect(fm.description).toBe("new desc");
    expect(fm.title).toBe("New Title");
  });

  test("merge keeps the old behavior for anyone who wants it", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: ["new-tag"],
        description: "new desc",
        title: "New Title",
      }),
    );

    const { app, fm } = makeApp({
      frontmatter: { tags: ["old-tag"], description: "old desc" },
    });

    await generateMetadata(
      app,
      makeSettings({ tagsPolicy: "merge", descriptionPolicy: "regenerate" }),
    );

    expect(fm.tags).toEqual(["old-tag", "new-tag"]);
  });

  test("each field's policy is independent of the others (#252)", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: ["new-tag"],
        description: "new desc",
        title: "New Title",
      }),
    );

    const { app, fm } = makeApp({
      frontmatter: {
        tags: ["stale-one", "stale-two"],
        description: "old desc",
        title: "Load-Bearing Title",
      },
    });

    // The bind #252 exists to break: cleaning up tags used to require
    // always_regenerate, which also rewrote every title unconditionally.
    await generateMetadata(
      app,
      makeSettings({
        tagsPolicy: "regenerate",
        descriptionPolicy: "regenerate",
        titlePolicy: "preserve",
      }),
    );

    expect(fm.tags).toEqual(["new-tag"]);
    expect(fm.description).toBe("new desc");
    expect(fm.title).toBe("Load-Bearing Title");
  });

  test("strips surrounding quotes from generated title before writing", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: ["a", "b"],
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
      toolUseResponse({ tags: ["a", "b"], description: "desc" }),
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
      toolUseResponse({ tags: ["a", "b"], description: "desc", title: "T" }),
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

  test("preserve does not overwrite a field the user filled in mid-request", async () => {
    const { app, fm } = makeApp({ frontmatter: {}, snapshotCache: true });

    // The note is empty when the request starts, so the pre-call snapshot says
    // "description is empty, safe to write". While the request is in flight the
    // user types a description into the open note.
    mockCreate.mockImplementationOnce(async () => {
      fm.description = "what the user typed";
      return toolUseResponse({
        tags: ["ai", "testing"],
        description: "what Claude generated",
        title: "Generated Title",
      });
    });

    await generateMetadata(app, makeSettings(PRESERVE_ALL));

    expect(fm.description).toBe("what the user typed");
    // Fields the user did not touch are still filled in.
    expect(fm.title).toBe("Generated Title");
    expect(fm.tags).toEqual(["ai", "testing"]);
  });

  test("preserve does not open the file for a field it is keeping", async () => {
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
        tags: ["ai", "testing"],
        description: "generated",
        title: "Generated",
      }),
    );

    await generateMetadata(app, makeSettings(PRESERVE_ALL));

    expect(writes()).toBe(1);
  });

  test("preserve keeps a field whose value is 0 or false", async () => {
    // Falsy but present. isEmptyValue used to report both as empty, so
    // shouldGenerate sent the note to the API and the update_if_empty re-check
    // then overwrote the very values it exists to protect (#201).
    const { app, fm } = makeApp({
      frontmatter: { description: 0, title: false },
      snapshotCache: true,
    });

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        tags: ["ai", "testing"],
        description: "what Claude generated",
        title: "Generated Title",
      }),
    );

    await generateMetadata(app, makeSettings(PRESERVE_ALL));

    expect(fm.description).toBe(0);
    expect(fm.title).toBe(false);
  });

  test("regenerate still overwrites, since the user asked for it", async () => {
    const { app, fm } = makeApp({ frontmatter: {}, snapshotCache: true });

    mockCreate.mockImplementationOnce(async () => {
      fm.description = "what the user typed";
      return toolUseResponse({
        tags: ["ai"],
        description: "what Claude generated",
        title: "Generated Title",
      });
    });

    await generateMetadata(
      app,
      makeSettings({
        tagsPolicy: "regenerate",
        descriptionPolicy: "regenerate",
        titlePolicy: "regenerate",
      }),
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
        tags: ["ai"],
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
        tags: ["ai"],
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

  test("a blank-only tags array writes nothing and reports no change", async () => {
    // A non-empty array of blanks passes validateMetadataInput, but
    // normalizeTags reduces it to []. That empty array was written as
    // `tags: []` and reported as a change (#161).
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: ["", "  ", " "], description: "", title: "" }),
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

  test("a quoted-empty title and a blank description write nothing", async () => {
    // `""` is truthy and survives validateMetadataInput, but
    // stripSurroundingQuotes unwraps it to "". Guarding on the raw string wrote
    // an empty title and reported "Metadata updated successfully"; the same
    // holds for a whitespace-only description.
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: [], description: "   ", title: '""' }),
    );
    const { app, fm, writes } = makeApp({});

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect("title" in fm).toBe(false);
    expect("description" in fm).toBe(false);
    expect(writes()).toBe(0);
    expect(result.kind).toBe("skipped");
  });

  test("a genuine no-op is still reported as skipped", async () => {
    // The model returned nothing usable, so no write is even attempted — the
    // case "skipped: no changes" is supposed to describe.
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: [], description: "", title: "" }),
    );
    const { app } = makeApp({});

    const result = await generateMetadataForFile(
      app,
      makeFile() as unknown as Parameters<typeof generateMetadataForFile>[1],
      makeSettings(),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("nothing_written");
    }
  });
});

describe("stripSurroundingQuotes", () => {
  test("unwraps a genuinely quoted title", () => {
    expect(stripSurroundingQuotes('"A Quoted Title"')).toBe("A Quoted Title");
    expect(stripSurroundingQuotes("'A Quoted Title'")).toBe("A Quoted Title");
  });

  test("leaves a title that merely opens and closes with quoted phrases", () => {
    // The old check was "first char is a quote and last char is a quote",
    // which this satisfies while not being a quoted string.
    expect(stripSurroundingQuotes('"Hello" and "Goodbye"')).toBe(
      '"Hello" and "Goodbye"',
    );
    expect(stripSurroundingQuotes("'Tis the season, said 'Bob'")).toBe(
      "'Tis the season, said 'Bob'",
    );
  });

  test("a different delimiter inside is not a reason to leave it wrapped", () => {
    expect(stripSurroundingQuotes(`"It's here"`)).toBe("It's here");
    expect(stripSurroundingQuotes(`'He said "hi"'`)).toBe('He said "hi"');
  });

  test("an apostrophe inside a word does not block unwrapping", () => {
    expect(stripSurroundingQuotes("'It's a Wonderful Life'")).toBe(
      "It's a Wonderful Life",
    );
    expect(stripSurroundingQuotes("'Don't Look Up'")).toBe("Don't Look Up");
  });

  test("a quote-shaped apostrophe still blocks it", () => {
    // 'Bob' opens after a space, so this is the ambiguous shape, not a
    // contraction.
    expect(stripSurroundingQuotes("'Tis the season, said 'Bob'")).toBe(
      "'Tis the season, said 'Bob'",
    );
  });

  test("genuinely ambiguous nesting is left alone in both directions", () => {
    // Wrapped, but indistinguishable in shape from the unwrapped case below.
    // Leaving a stray pair of quotes beats slicing characters off a title.
    expect(stripSurroundingQuotes('"The "Great" Gatsby"')).toBe(
      '"The "Great" Gatsby"',
    );
    expect(stripSurroundingQuotes('"Hello" and "Goodbye"')).toBe(
      '"Hello" and "Goodbye"',
    );
  });

  test("mismatched outer quotes are not a wrapper", () => {
    expect(stripSurroundingQuotes(`"Mixed'`)).toBe(`"Mixed'`);
  });

  test("a lone quote character is left alone", () => {
    // startsWith and endsWith are both true for a one-character string, and
    // substring(1, 0) silently returned the original rather than "".
    expect(stripSurroundingQuotes('"')).toBe('"');
    expect(stripSurroundingQuotes("'")).toBe("'");
  });

  test("an unquoted title is returned trimmed", () => {
    expect(stripSurroundingQuotes("  Plain Title  ")).toBe("Plain Title");
  });

  test("empty and whitespace input", () => {
    expect(stripSurroundingQuotes("")).toBe("");
    expect(stripSurroundingQuotes("   ")).toBe("");
  });

  test('unwraps to an empty string for ""', () => {
    expect(stripSurroundingQuotes('""')).toBe("");
  });
});

describe("existing tags reach the request (#251)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  function sentUserMessage(): string {
    const body = mockCreate.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    return body.messages[0].content;
  }

  function sentSystem(): string {
    const body = mockCreate.mock.calls[0]?.[0] as { system: string };
    return body.system;
  }

  // getContent strips frontmatter before the request (#164), so without this
  // wiring the model never sees the tags it is being asked to replace and every
  // run is an independent draw from the body.
  test("a note's current tags are sent for reconciliation", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: ["fresh"], description: "d", title: "T" }),
    );
    const { app } = makeApp({
      frontmatter: { tags: ["science-fiction", "review"] },
      content: "body text",
    });

    await generateMetadata(
      app,
      makeSettings({
        tagsPolicy: "regenerate",
        descriptionPolicy: "regenerate",
        titlePolicy: "regenerate",
      }),
    );

    expect(sentUserMessage()).toContain("science-fiction\nreview");
    expect(sentSystem()).toContain("keep each tag that still fits");
  });

  test("a scalar tags value is read too, not just a list", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: ["fresh"], description: "d", title: "T" }),
    );
    const { app } = makeApp({
      frontmatter: { tags: "solo-tag" },
      content: "body text",
    });

    await generateMetadata(
      app,
      makeSettings({
        tagsPolicy: "regenerate",
        descriptionPolicy: "regenerate",
        titlePolicy: "regenerate",
      }),
    );

    expect(sentUserMessage()).toContain("solo-tag");
  });

  test("a note with no tags gets no reconciliation instruction", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: ["fresh"], description: "d", title: "T" }),
    );
    const { app } = makeApp({ content: "body text" });

    await generateMetadata(app, makeSettings());

    expect(sentSystem()).not.toContain("current tags");
    expect(sentUserMessage()).not.toContain("current-tags");
  });

  // The field name is configurable, so the read must follow the setting rather
  // than assume "tags".
  test("reads the configured tags field name", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ tags: ["fresh"], description: "d", title: "T" }),
    );
    const { app } = makeApp({
      frontmatter: { keywords: ["from-keywords"] },
      content: "body text",
    });

    await generateMetadata(
      app,
      makeSettings({
        tagsFieldName: "keywords",
        tagsPolicy: "regenerate",
        descriptionPolicy: "regenerate",
        titlePolicy: "regenerate",
      }),
    );

    expect(sentUserMessage()).toContain("from-keywords");
  });
});
