import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { FakeNotice, FakeTFile, FakeTFolder, obsidianDoubles } from "./testDom";

const mockCreate = mock();

// Only the SDK is mocked. First-party modules deliberately are not:
// mock.module is global across the whole run, so mocking "./bulkGenerate" here
// would hand the stub to bulkGenerate.test.ts as well.
mock.module("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {
    status = 429;
  }
  class InternalServerError extends Error {
    status = 529;
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

mock.module("obsidian", () => obsidianDoubles);

const { runBulkForFolder } = await import("./bulkOrchestrator");
const { BulkConfirmModal } = await import("./bulkConfirmModal");
const { BulkProgressModal } = await import("./bulkProgressModal");

const TOOL_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "submit_metadata",
      input: { tags: "a", description: "d", title: "T" },
    },
  ],
};

// Prototype patches are process-wide, so each is saved here and restored in
// afterEach rather than left in place for whatever file runs next.
const realConfirm = BulkConfirmModal.prototype.openAndAwait;
const realSetProgress = BulkProgressModal.prototype.setProgress;

let confirmAnswer = true;

beforeEach(() => {
  confirmAnswer = true;
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(TOOL_RESPONSE);
  FakeNotice.messages.length = 0;
  BulkConfirmModal.prototype.openAndAwait = async () => confirmAnswer;
});

afterEach(() => {
  BulkConfirmModal.prototype.openAndAwait = realConfirm;
  BulkProgressModal.prototype.setProgress = realSetProgress;
});

function settings(
  overrides: Partial<MetadataToolSettings> = {},
): MetadataToolSettings {
  return { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-test", ...overrides };
}

function file(path: string): TFile {
  return Object.assign(new FakeTFile(), {
    path,
    name: path,
    extension: "md",
    basename: path.replace(/\.[^.]+$/, ""),
  }) as unknown as TFile;
}

function folderOf(...paths: string[]) {
  return Object.assign(new FakeTFolder(), {
    path: "notes",
    name: "notes",
    children: paths.map(file),
  }) as unknown as Parameters<typeof runBulkForFolder>[1];
}

function makeApp(): App {
  const store = new Map<string, Record<string, unknown>>();
  return {
    workspace: {},
    metadataCache: {
      getFileCache: (f: TFile) => ({ frontmatter: store.get(f.path) ?? {} }),
    },
    vault: { read: async () => "note body content" },
    fileManager: {
      processFrontMatter: async (
        f: TFile,
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        const fm = store.get(f.path) ?? {};
        fn(fm);
        store.set(f.path, fm);
      },
    },
  } as unknown as App;
}

// Counts abort listeners added and removed on a real AbortSignal.
function trackedSignal() {
  const controller = new AbortController();
  const added: string[] = [];
  const removed: string[] = [];
  const realAdd = controller.signal.addEventListener.bind(controller.signal);
  const realRemove = controller.signal.removeEventListener.bind(
    controller.signal,
  );
  controller.signal.addEventListener = (type: string, ...rest: never[]) => {
    added.push(type);
    return realAdd(type, ...rest);
  };
  controller.signal.removeEventListener = (type: string, ...rest: never[]) => {
    removed.push(type);
    return realRemove(type, ...rest);
  };
  return { controller, added, removed };
}

describe("runBulkForFolder", () => {
  test("detaches its abort listener once the run is over", async () => {
    const { controller, added, removed } = trackedSignal();

    await runBulkForFolder(makeApp(), folderOf("a.md"), settings(), {
      signal: controller.signal,
    });

    // Without the removal every bulk run would leave one behind on a signal
    // that lives until onunload.
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
  });

  test("detaches the listener even when the run throws", async () => {
    const { controller, removed } = trackedSignal();
    // setProgress is called from inside the try, so this exercises the finally.
    BulkProgressModal.prototype.setProgress = () => {
      throw new Error("progress modal exploded");
    };

    await expect(
      runBulkForFolder(makeApp(), folderOf("a.md"), settings(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("progress modal exploded");

    expect(removed).toEqual(["abort"]);
  });

  test("forwards an abort on the plugin signal into the run", async () => {
    const controller = new AbortController();
    // Abort once the first file is under way; the run must stop short.
    BulkProgressModal.prototype.setProgress = () => {
      controller.abort("plugin_unloaded");
    };

    await runBulkForFolder(
      makeApp(),
      folderOf("a.md", "b.md", "c.md"),
      settings(),
      { signal: controller.signal },
    );

    expect(mockCreate.mock.calls.length).toBeLessThan(3);
  });

  test("an already-aborted signal runs no files at all", async () => {
    const controller = new AbortController();
    controller.abort("plugin_unloaded");

    await runBulkForFolder(makeApp(), folderOf("a.md"), settings(), {
      signal: controller.signal,
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("declining the confirm modal runs nothing", async () => {
    confirmAnswer = false;

    await runBulkForFolder(makeApp(), folderOf("a.md"), settings());

    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("a missing API key stops before any modal", async () => {
    await runBulkForFolder(
      makeApp(),
      folderOf("a.md"),
      settings({ anthropicApiKey: "" }),
    );

    expect(FakeNotice.messages.join(" ")).toContain(
      "configure your Anthropic API key",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("a folder with no markdown files stops with a notice", async () => {
    await runBulkForFolder(makeApp(), folderOf(), settings());

    expect(FakeNotice.messages.join(" ")).toContain("No markdown files found");
  });

  test("a folder where nothing needs generating stops with a notice", async () => {
    const app = makeApp();
    const populated = {
      tags: ["x"],
      description: "d",
      title: "T",
    };
    app.metadataCache.getFileCache = () =>
      ({ frontmatter: populated }) as ReturnType<
        App["metadataCache"]["getFileCache"]
      >;

    await runBulkForFolder(app, folderOf("a.md"), settings());

    expect(FakeNotice.messages.join(" ")).toContain("already have metadata");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
