import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type MetadataConfig,
  NO_FIELDS_ENABLED_MESSAGE,
} from "./settings";

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

const { generateForPath } = await import("./cli");
const { resetClientCache } = await import("./adapters/claude");

beforeEach(() => {
  resetClientCache();
  mockCreate.mockReset();
});

function toolUse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", id: "tu_1", name: "submit_metadata", input }],
  };
}

function makeApp(opts: {
  frontmatter?: Record<string, unknown>;
  failWrites?: boolean;
  extension?: string;
}): App {
  const fm = { ...(opts.frontmatter ?? {}) };
  const file = { extension: opts.extension ?? "md", path: "Inbox/X.md" };
  // JSON is valid YAML; the shared parseYaml double reads it back.
  const onDisk = () => `---\n${JSON.stringify(fm)}\n---\nbody`;
  return {
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
    vault: {
      getFileByPath: (p: string) => (p === file.path ? file : null),
      cachedRead: async () => "body",
      read: async () => onDisk(),
    },
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

const settings = (o: Partial<MetadataConfig> = {}) => ({
  ...DEFAULT_SETTINGS,
  anthropicApiKey: "sk-test",
  ...o,
});

const run = async (app: App, s: MetadataConfig, params = {}) =>
  JSON.parse(await generateForPath(app, s, { path: "Inbox/X.md", ...params }));

describe("metadator:generate", () => {
  test("writes the note and prints what it now holds", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));

    const out = await run(makeApp({}), settings({ enableTitle: true }));

    expect(out).toEqual({
      status: "changed",
      file: "Inbox/X.md",
      title: "T",
      description: "d",
    });
  });

  test("prints the note's values, not the model's, under preserve", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));

    const out = await run(
      makeApp({ frontmatter: { title: "Kept" } }),
      settings({ titlePolicy: "preserve" }),
    );

    expect(out.title).toBe("Kept");
    expect(out.description).toBe("d");
  });

  // Tag generation is gone (#310): a note's existing tags are neither
  // rewritten nor reported.
  test("leaves a note's tags alone and does not print them", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));
    const app = makeApp({ frontmatter: { tags: ["old"] } });

    const out = await run(app, settings());

    expect(out).not.toHaveProperty("tags");
    expect(await app.vault.read({} as never)).toContain('"tags":["old"]');
  });

  test("a missing key is a returned skip, not a throw", async () => {
    const out = await run(makeApp({}), settings({ anthropicApiKey: "" }));

    expect(out).toMatchObject({ status: "skipped", reason: "no_api_key" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("a failed write comes back as an error", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));

    const out = await run(makeApp({ failWrites: true }), settings());

    expect(out.status).toBe("error");
    expect(out.reason).toContain("failed to write frontmatter");
  });

  test("an API failure comes back as an error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"));

    const out = await run(makeApp({}), settings());

    expect(out.status).toBe("error");
  });

  test("an unknown path is an error, and nothing is called", async () => {
    const out = await run(makeApp({}), settings(), { path: "Nope.md" });

    expect(out).toEqual({
      status: "error",
      file: "Nope.md",
      reason: "no such file",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("a missing or bare path flag is an error", async () => {
    const app = makeApp({});
    for (const params of [{}, { path: "true" }]) {
      const out = JSON.parse(await generateForPath(app, settings(), params));
      expect(out.status).toBe("error");
    }
  });

  test("a non-markdown file is skipped without reading it", async () => {
    const out = await run(makeApp({ extension: "pdf" }), settings());

    expect(out).toEqual({
      status: "skipped",
      file: "Inbox/X.md",
      reason: "not_markdown",
    });
  });
});

describe("metadator:generate with both fields disabled (#305)", () => {
  test("returns an error naming the settings and makes no API call", async () => {
    const out = await run(
      makeApp({}),
      settings({
        enableDescription: false,
        enableTitle: false,
      }),
    );

    expect(out).toEqual({ status: "error", reason: NO_FIELDS_ENABLED_MESSAGE });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("metadator:generate dry-run", () => {
  const dryRun = { "dry-run": "true" };

  test("prints what would be written and writes nothing", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));
    const app = makeApp({});

    const out = await run(app, settings({ titlePolicy: "regenerate" }), dryRun);

    expect(out).toEqual({
      status: "preview",
      file: "Inbox/X.md",
      title: "T",
      description: "d",
    });
    expect(await app.vault.read({} as never)).toBe("---\n{}\n---\nbody");
  });

  test("leaves out a field that preserve would keep", async () => {
    mockCreate.mockResolvedValueOnce(toolUse({ description: "d", title: "T" }));

    const out = await run(
      makeApp({ frontmatter: { title: "Kept" } }),
      settings({ titlePolicy: "preserve" }),
      dryRun,
    );

    expect(out).toEqual({
      status: "preview",
      file: "Inbox/X.md",
      description: "d",
    });
  });

  test("skips like a real run, before any call", async () => {
    const out = await run(
      makeApp({ frontmatter: { title: "Kept", description: "Kept" } }),
      settings({ titlePolicy: "preserve", descriptionPolicy: "preserve" }),
      dryRun,
    );

    expect(out).toMatchObject({
      status: "skipped",
      reason: "already_populated",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("an API failure comes back as an error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"));

    const out = await run(makeApp({}), settings(), dryRun);

    expect(out.status).toBe("error");
  });
});

describe("metadator:generate with the eyebrow field (#308)", () => {
  const on = (o: Partial<MetadataConfig> = {}) =>
    settings({ enableEyebrow: true, ...o });

  test("writes a listed value", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ description: "d", title: "T", eyebrow: "Poem" }),
    );

    const out = await run(makeApp({}), on());

    expect(out).toMatchObject({ status: "changed", eyebrow: "Poem" });
  });

  test("writes nothing for an essay, and the other fields still land", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ description: "d", title: "T", eyebrow: "" }),
    );
    const app = makeApp({});

    const out = await run(app, on());

    expect(out).toEqual({
      status: "changed",
      file: "Inbox/X.md",
      title: "T",
      description: "d",
    });
    expect(await app.vault.read({} as never)).not.toContain("eyebrow");
  });

  test("never writes an off-list value", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ description: "d", title: "T", eyebrow: "Essay" }),
    );
    const app = makeApp({});

    await run(app, on());

    expect(await app.vault.read({} as never)).not.toContain("Essay");
  });

  test("keeps a hand-set value under preserve", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ description: "d", title: "T", eyebrow: "Poem" }),
    );

    const out = await run(
      makeApp({ frontmatter: { eyebrow: "Fiction" } }),
      on(),
    );

    expect(out.eyebrow).toBe("Fiction");
  });

  test("a dry run proposes it", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUse({ description: "d", title: "T", eyebrow: "Quotation" }),
    );

    const out = await run(makeApp({}), on({ titlePolicy: "regenerate" }), {
      "dry-run": "true",
    });

    expect(out).toEqual({
      status: "preview",
      file: "Inbox/X.md",
      title: "T",
      description: "d",
      eyebrow: "Quotation",
    });
  });
});
