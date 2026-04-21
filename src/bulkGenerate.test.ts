import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";

const mockCreate = mock();

mock.module("@anthropic-ai/sdk", () => {
  class RateLimitError extends Error {
    status = 429;
  }
  class InternalServerError extends Error {
    status = 529;
  }
  class APIError extends Error {}
  class AuthenticationError extends Error {}
  class Anthropic {
    messages = { create: mockCreate };
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static InternalServerError = InternalServerError;
    static APIError = APIError;
  }
  return { default: Anthropic };
});

const {
  collectCandidates,
  classifyCandidates,
  runBulk,
  DEFAULT_RETRY_DELAYS_MS,
} = await import("./bulkGenerate");

// Zero delays in tests to keep the suite fast; production uses DEFAULT_RETRY_DELAYS_MS.
const FAST_RETRIES = [0, 0, 0];

function file(name: string, ext = "md"): TFile {
  return {
    path: name,
    name,
    extension: ext,
    basename: name.replace(/\.[^.]+$/, ""),
  } as unknown as TFile;
}

function folder(name: string, children: Array<TFile | TFolder>): TFolder {
  return {
    path: name,
    name,
    children,
  } as unknown as TFolder;
}

function settings(
  overrides: Partial<MetadataToolSettings> = {},
): MetadataToolSettings {
  return {
    ...DEFAULT_SETTINGS,
    anthropicApiKey: "sk-test-key",
    ...overrides,
  };
}

function makeApp(
  frontmatters: Map<string, Record<string, unknown>> = new Map(),
): App {
  return {
    workspace: {},
    metadataCache: {
      getFileCache: (f: TFile) => ({
        frontmatter: frontmatters.get(f.path) ?? {},
      }),
    },
    vault: {
      read: async () => "note body content",
    },
    fileManager: {
      processFrontMatter: async (
        f: TFile,
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        const fm = frontmatters.get(f.path) ?? {};
        fn(fm);
        frontmatters.set(f.path, fm);
      },
    },
  } as unknown as App;
}

describe("collectCandidates", () => {
  test("collects markdown files from a flat folder", () => {
    const f = folder("root", [
      file("a.md"),
      file("b.md"),
      file("c.pdf", "pdf"),
    ]);
    const result = collectCandidates(f);
    expect(result.map((x: TFile) => x.path)).toEqual(["a.md", "b.md"]);
  });

  test("recurses into subfolders", () => {
    const sub = folder("sub", [file("c.md"), file("d.md")]);
    const root = folder("root", [file("a.md"), sub]);
    const result = collectCandidates(root);
    expect(result.map((x: TFile) => x.path)).toEqual(["a.md", "c.md", "d.md"]);
  });

  test("filters non-markdown files", () => {
    const f = folder("root", [
      file("keep.md"),
      file("image.png", "png"),
      file("canvas.canvas", "canvas"),
    ]);
    const result = collectCandidates(f);
    expect(result.map((x: TFile) => x.path)).toEqual(["keep.md"]);
  });

  test("returns empty for folder with no markdown files", () => {
    const f = folder("root", [file("a.pdf", "pdf")]);
    expect(collectCandidates(f)).toEqual([]);
  });

  test("handles empty folder", () => {
    expect(collectCandidates(folder("empty", []))).toEqual([]);
  });
});

describe("classifyCandidates", () => {
  test("preserve_existing: notes with all fields populated go to willSkip", () => {
    const f1 = file("full.md");
    const f2 = file("empty.md");
    const app = makeApp(
      new Map([
        ["full.md", { tags: ["a"], description: "desc", title: "Title" }],
        ["empty.md", {}],
      ]),
    );
    const result = classifyCandidates(
      app,
      [f1, f2],
      settings({ updateMethod: "preserve_existing" }),
    );
    expect(result.willChange.map((f: TFile) => f.path)).toEqual(["empty.md"]);
    expect(result.willSkip.map((f: TFile) => f.path)).toEqual(["full.md"]);
  });

  test("preserve_existing: note missing one field goes to willChange", () => {
    const f = file("partial.md");
    const app = makeApp(
      new Map([["partial.md", { tags: ["a"], description: "desc" }]]),
    );
    const result = classifyCandidates(
      app,
      [f],
      settings({ updateMethod: "preserve_existing" }),
    );
    expect(result.willChange.map((f: TFile) => f.path)).toEqual(["partial.md"]);
  });

  test("always_regenerate: all notes go to willChange", () => {
    const f1 = file("full.md");
    const f2 = file("empty.md");
    const app = makeApp(
      new Map([
        ["full.md", { tags: ["a"], description: "desc", title: "Title" }],
        ["empty.md", {}],
      ]),
    );
    const result = classifyCandidates(
      app,
      [f1, f2],
      settings({ updateMethod: "always_regenerate" }),
    );
    expect(result.willChange).toHaveLength(2);
    expect(result.willSkip).toHaveLength(0);
  });

  test("respects enableTitle — missing title only triggers change when enabled", () => {
    const f = file("titleless.md");
    const app = makeApp(
      new Map([["titleless.md", { tags: ["a"], description: "desc" }]]),
    );

    const withTitle = classifyCandidates(
      app,
      [f],
      settings({ updateMethod: "preserve_existing", enableTitle: true }),
    );
    expect(withTitle.willChange).toHaveLength(1);

    const withoutTitle = classifyCandidates(
      app,
      [f],
      settings({ updateMethod: "preserve_existing", enableTitle: false }),
    );
    expect(withoutTitle.willChange).toHaveLength(0);
  });
});

describe("runBulk", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test("processes files sequentially with progress callbacks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"tags": "a,b", "description": "d", "title": "T"}',
        },
      ],
    });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    const progressCalls: number[] = [];
    const results = await runBulk(app, files, settings(), {
      onProgress: (p: { current: number }) => progressCalls.push(p.current),
    });
    expect(results).toHaveLength(3);
    expect(results.every((r: { kind: string }) => r.kind === "changed")).toBe(
      true,
    );
    expect(progressCalls).toEqual([1, 2, 3]);
  });

  test("aborts mid-loop when shouldAbort returns true", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"tags": "a", "description": "d", "title": "T"}',
        },
      ],
    });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    let processed = 0;
    const results = await runBulk(app, files, settings(), {
      onProgress: () => {
        processed++;
      },
      shouldAbort: () => processed >= 2,
    });
    expect(results.length).toBeLessThan(3);
  });

  test("per-file error isolation — one failure does not abort batch", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"tags": "a", "description": "d"}' }],
      })
      .mockRejectedValueOnce(new Error("some API error"))
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"tags": "c", "description": "d"}' }],
      });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    const results = await runBulk(app, files, settings());
    expect(results).toHaveLength(3);
    expect(results[0].kind).toBe("changed");
    expect(results[1].kind).toBe("error");
    expect(results[2].kind).toBe("changed");
  });

  test("retries on rate-limit error and eventually succeeds", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      RateLimitError: new (msg: string) => Error;
    };
    const rateLimit = new Anthropic.RateLimitError("429");
    mockCreate.mockRejectedValueOnce(rateLimit).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"tags": "a", "description": "d"}' }],
    });
    const files = [file("n1.md")];
    const app = makeApp();
    const results = await runBulk(app, files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });
    expect(results[0].kind).toBe("changed");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test("gives up after retry budget exhausted and records error", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      RateLimitError: new (msg: string) => Error;
    };
    const rateLimit = new Anthropic.RateLimitError("429");
    mockCreate.mockRejectedValue(rateLimit);
    const files = [file("n1.md")];
    const app = makeApp();
    const results = await runBulk(app, files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });
    expect(results[0].kind).toBe("error");
    expect(mockCreate).toHaveBeenCalledTimes(1 + FAST_RETRIES.length);
  });

  test("skips files missing API key in settings", async () => {
    const files = [file("n1.md")];
    const app = makeApp();
    const results = await runBulk(
      app,
      files,
      settings({ anthropicApiKey: "" }),
    );
    expect(results[0].kind).toBe("skipped");
  });

  test("DEFAULT_RETRY_DELAYS_MS is production default", () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([2_000, 8_000, 30_000]);
  });
});
