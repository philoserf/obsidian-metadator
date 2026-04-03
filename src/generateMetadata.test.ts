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
const { generateMetadata } = await import("./metadata");

function makeApp(opts: {
  file?: { extension: string } | null;
  frontmatter?: Record<string, unknown>;
  content?: string;
}): { app: App; fm: Record<string, unknown> } {
  const fm = { ...(opts.frontmatter ?? {}) };
  const file = "file" in opts ? opts.file : { extension: "md" };

  const app = {
    workspace: {
      getActiveFile: () => file,
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: fm }),
    },
    vault: {
      read: async () => opts.content ?? "Some article content for testing.",
    },
    fileManager: {
      processFrontMatter: async (
        _file: unknown,
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        fn(fm);
      },
    },
  } as unknown as App;

  return { app, fm };
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
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"tags": "ai,testing", "description": "A test article", "title": "Test Title"}',
        },
      ],
    });

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
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"tags": "new-tag", "description": "new desc", "title": "New Title"}',
        },
      ],
    });

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
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"tags": "new-tag", "description": "new desc", "title": "New Title"}',
        },
      ],
    });

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

  test("does not generate title when enableTitle is false", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"tags": "a,b", "description": "desc", "title": "Should Ignore"}',
        },
      ],
    });

    const { app, fm } = makeApp({});
    const settings = makeSettings({ enableTitle: false });

    await generateMetadata(app, settings);

    expect(fm.tags).toEqual(["a", "b"]);
    expect(fm.description).toBe("desc");
    expect(fm.title).toBeUndefined();
  });
});
