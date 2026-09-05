import { beforeEach, describe, expect, mock, test } from "bun:test";
import { type App, TFile, TFolder } from "obsidian";
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
  computeDelayMs,
  runBulk,
  DEFAULT_RETRY_DELAYS_MS,
  CONSECUTIVE_FAILURE_LIMIT,
} = await import("./bulkGenerate");
const { ClaudeApiError } = await import("./adapters/claude");

// Zero delays in tests to keep the suite fast; production uses DEFAULT_RETRY_DELAYS_MS.
const FAST_RETRIES = [0, 0, 0];

// Real instances of the classes test-preload.ts mocks for "obsidian":
// collectCandidates discriminates with instanceof, which a plain object
// literal cast to TFile/TFolder would fail.
function file(name: string, ext = "md"): TFile {
  return Object.assign(new TFile(), {
    path: name,
    name,
    extension: ext,
    basename: name.replace(/\.[^.]+$/, ""),
  });
}

function folder(name: string, children: Array<TFile | TFolder>): TFolder {
  return Object.assign(new TFolder(), {
    path: name,
    name,
    children,
  });
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

  test("returns files in path order regardless of children order", () => {
    const f = folder("root", [file("c.md"), file("a.md"), file("b.md")]);
    expect(collectCandidates(f).map((x: TFile) => x.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  test("orders case-insensitively, not by code point", () => {
    // A code-point sort would put every uppercase path first ("B.md", "a.md").
    // The pinned "en" collation interleaves them the way the file explorer does.
    const f = folder("root", [file("c.md"), file("a.md"), file("B.md")]);
    expect(collectCandidates(f).map((x: TFile) => x.path)).toEqual([
      "a.md",
      "B.md",
      "c.md",
    ]);
  });

  test("sorts across subtrees, not just within each folder", () => {
    // Depth-first order would be b/x.md, b/y.md, a.md — the sort has to run
    // over the whole collected tree, not per level.
    const sub = folder("b", [file("b/x.md"), file("b/y.md")]);
    const root = folder("root", [sub, file("a.md")]);
    expect(collectCandidates(root).map((x: TFile) => x.path)).toEqual([
      "a.md",
      "b/x.md",
      "b/y.md",
    ]);
  });

  test("skips children that are neither TFile nor TFolder", () => {
    const f = folder("root", [
      file("keep.md"),
      { path: "impostor.md", extension: "md" } as unknown as TFile,
    ]);
    expect(collectCandidates(f).map((x: TFile) => x.path)).toEqual(["keep.md"]);
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
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "a,b", description: "d", title: "T" },
        },
      ],
    });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    const progressCalls: number[] = [];
    const { results } = await runBulk(app, files, settings(), {
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
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "a", description: "d", title: "T" },
        },
      ],
    });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    let processed = 0;
    const { results } = await runBulk(app, files, settings(), {
      onProgress: () => {
        processed++;
      },
      shouldAbort: () => processed >= 2,
    });
    expect(results.length).toBeLessThan(3);
  });

  test("halts the whole run on the first auth error", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      AuthenticationError: new (msg: string) => Error;
    };
    mockCreate.mockRejectedValue(new Anthropic.AuthenticationError("401"));
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];

    const { results, halted } = await runBulk(makeApp(), files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });

    // A rejected key rejects every remaining file too, so one round-trip is
    // all the evidence needed — the other two notes are never requested.
    expect(halted?.kind).toBe("auth");
    expect(results).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("halts after CONSECUTIVE_FAILURE_LIMIT identical non-retryable errors", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const files = Array.from({ length: 10 }, (_, i) => file(`n${i}.md`));

    const { results, halted } = await runBulk(makeApp(), files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });

    expect(halted?.consecutive).toBe(CONSECUTIVE_FAILURE_LIMIT);
    expect(results).toHaveLength(CONSECUTIVE_FAILURE_LIMIT);
  });

  test("a success resets the consecutive-failure streak", async () => {
    const ok = {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "a", description: "d", title: "T" },
        },
      ],
    };
    // Four failures, a success, then four more: never five in a row, so the
    // run must reach the end rather than halting.
    mockCreate
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));
    const files = Array.from({ length: 9 }, (_, i) => file(`n${i}.md`));

    const { results, halted } = await runBulk(makeApp(), files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });

    expect(halted).toBeUndefined();
    expect(results).toHaveLength(9);
  });

  test("exhausted rate limits do not count toward the halt streak", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      RateLimitError: new (msg: string) => Error;
    };
    mockCreate.mockRejectedValue(new Anthropic.RateLimitError("429"));
    const files = Array.from({ length: 8 }, (_, i) => file(`n${i}.md`));

    const { results, halted } = await runBulk(makeApp(), files, settings(), {
      retryDelaysMs: [0],
    });

    // Throttling is a "try later", not a broken configuration. Every file is
    // still attempted; the retry loop already backed each one off.
    expect(halted).toBeUndefined();
    expect(results).toHaveLength(8);
  });

  test("per-file error isolation — one failure does not abort batch", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "submit_metadata",
            input: { tags: "a", description: "d", title: "T" },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("some API error"))
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "submit_metadata",
            input: { tags: "c", description: "d", title: "T" },
          },
        ],
      });
    const files = [file("n1.md"), file("n2.md"), file("n3.md")];
    const app = makeApp();
    const { results } = await runBulk(app, files, settings());
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
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "a", description: "d", title: "T" },
        },
      ],
    });
    const files = [file("n1.md")];
    const app = makeApp();
    const { results } = await runBulk(app, files, settings(), {
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
    const { results } = await runBulk(app, files, settings(), {
      retryDelaysMs: FAST_RETRIES,
    });
    expect(results[0].kind).toBe("error");
    expect(mockCreate).toHaveBeenCalledTimes(1 + FAST_RETRIES.length);
  });

  test("skips files missing API key in settings", async () => {
    const files = [file("n1.md")];
    const app = makeApp();
    const { results } = await runBulk(
      app,
      files,
      settings({ anthropicApiKey: "" }),
    );
    expect(results[0].kind).toBe("skipped");
  });

  test("DEFAULT_RETRY_DELAYS_MS is production default", () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([2_000, 8_000, 30_000]);
  });

  test("abort before first attempt skips without calling the API", async () => {
    const files = [file("n1.md")];
    const app = makeApp();
    let aborted = false;
    const { results } = await runBulk(app, files, settings(), {
      retryDelaysMs: [5_000],
      shouldAbort: () => aborted,
      onProgress: () => {
        // onProgress fires after runBulk's pre-loop shouldAbort check but
        // before runFileWithRetry calls the API; the per-attempt guard must
        // catch it so no API call is made.
        aborted = true;
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    if (results[0].kind === "skipped") {
      expect(results[0].reason).toContain("cancelled");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("abort during retry backoff returns skipped-cancelled after one API call", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      RateLimitError: new (msg: string) => Error;
    };
    let aborted = false;
    mockCreate.mockImplementation(async () => {
      // Fire abort on the next tick, after this throw resolves — so
      // runFileWithRetry sees the error, enters sleepAbortable, and then
      // picks up the abort during polling.
      setTimeout(() => {
        aborted = true;
      }, 0);
      throw new Anthropic.RateLimitError("429");
    });
    const files = [file("n1.md")];
    const app = makeApp();
    const start = Date.now();
    const { results } = await runBulk(app, files, settings(), {
      retryDelaysMs: [5_000],
      shouldAbort: () => aborted,
    });
    const elapsed = Date.now() - start;
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Abort polls every 100ms; should return well under the 5s retry delay.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("signal abort during retry backoff returns skipped quickly", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk"))
      .default as unknown as {
      RateLimitError: new (msg: string) => Error;
    };
    const controller = new AbortController();
    mockCreate.mockRejectedValueOnce(new Anthropic.RateLimitError("429"));
    const files = [file("n1.md")];
    const app = makeApp();

    const run = runBulk(app, files, settings(), {
      retryDelaysMs: [5_000],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("plugin_unloaded"), 0);

    const start = Date.now();
    const { results } = await run;
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("passes abort signal through bulk generation calls", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "submit_metadata",
          input: { tags: "a", description: "d", title: "T" },
        },
      ],
    });
    const files = [file("n1.md")];
    const app = makeApp();
    const controller = new AbortController();

    await runBulk(app, files, settings(), { signal: controller.signal });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  test("skips when bulk signal is already aborted", async () => {
    const files = [file("n1.md")];
    const app = makeApp();
    const controller = new AbortController();
    controller.abort("plugin_unloaded");

    const { results } = await runBulk(app, files, settings(), {
      signal: controller.signal,
    });

    expect(results).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("computeDelayMs", () => {
  test("applies low-end jitter (random=0 → 0.5x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0)).toBe(500);
  });

  test("applies high-end jitter (random≈1 → ~1.5x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0.999)).toBe(1499);
  });

  test("applies mid-range jitter (random=0.5 → 1.0x base)", () => {
    expect(computeDelayMs(1000, undefined, () => 0.5)).toBe(1000);
  });

  test("returns 0 when base delay is 0 (zero-delay tests stay deterministic)", () => {
    expect(computeDelayMs(0, undefined, () => 0.7)).toBe(0);
  });

  test("ignores non-ClaudeApiError values when computing jitter", () => {
    expect(computeDelayMs(1000, new Error("plain"), () => 0)).toBe(500);
  });

  test("honors retryAfterMs from a ClaudeApiError when provided", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 800);
    expect(computeDelayMs(1000, err, () => 0)).toBe(800);
  });

  test("caps retryAfterMs at 2x base to avoid stalling the bulk loop", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 60_000);
    expect(computeDelayMs(1000, err, () => 0)).toBe(2000);
  });

  test("honors retryAfterMs of 0 (server says retry immediately)", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited", 0);
    expect(computeDelayMs(1000, err, () => 0.999)).toBe(0);
  });

  test("falls back to jitter when retryAfterMs is undefined on a ClaudeApiError", () => {
    const err = new ClaudeApiError("rate_limit", "rate limited");
    expect(computeDelayMs(1000, err, () => 0)).toBe(500);
  });
});
