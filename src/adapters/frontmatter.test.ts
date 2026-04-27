import { describe, expect, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { updateFrontMatter } from "./frontmatter";

function makeApp(initial: Record<string, unknown> = {}): {
  app: App;
  fm: Record<string, unknown>;
} {
  const fm = { ...initial };
  const app = {
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

describe("updateFrontMatter", () => {
  test("keep: preserves an existing value", async () => {
    const { app, fm } = makeApp({ description: "existing" });
    await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new value",
      "keep",
    );
    expect(fm.description).toBe("existing");
  });

  test("keep: sets the value when field is absent", async () => {
    const { app, fm } = makeApp({});
    await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new value",
      "keep",
    );
    expect(fm.description).toBe("new value");
  });

  test("update: overwrites an existing value", async () => {
    const { app, fm } = makeApp({ description: "old" });
    await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new value",
      "update",
    );
    expect(fm.description).toBe("new value");
  });

  test("append: merges and deduplicates array oldValue", async () => {
    const { app, fm } = makeApp({ tags: ["a", "b"] });
    await updateFrontMatter(app, {} as TFile, "tags", ["b", "c"], "append");
    expect(fm.tags).toEqual(["a", "b", "c"]);
  });

  test("append: normalises string oldValue to array before merge", async () => {
    const { app, fm } = makeApp({ tags: "existing-tag" });
    await updateFrontMatter(app, {} as TFile, "tags", ["new-tag"], "append");
    expect(fm.tags).toEqual(["existing-tag", "new-tag"]);
  });

  test("append: initialises correctly when field is absent", async () => {
    const { app, fm } = makeApp({});
    await updateFrontMatter(app, {} as TFile, "tags", ["a", "b"], "append");
    expect(fm.tags).toEqual(["a", "b"]);
  });

  test("append: returns false when all values already present", async () => {
    const { app, fm } = makeApp({ tags: ["a", "b", "c"] });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["a", "b"],
      "append",
    );
    expect(changed).toBe(false);
    expect(fm.tags).toEqual(["a", "b", "c"]);
  });

  test("append: returns true when new values added", async () => {
    const { app } = makeApp({ tags: ["a"] });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["b"],
      "append",
    );
    expect(changed).toBe(true);
  });

  test("append: returns true when dedup swaps an element while preserving length", async () => {
    const { app, fm } = makeApp({ tags: ["a", "a", "b"] });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["c"],
      "append",
    );
    expect(changed).toBe(true);
    expect(fm.tags).toEqual(["a", "b", "c"]);
  });

  test("update: returns false when value is unchanged", async () => {
    const { app } = makeApp({ description: "same" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "same",
      "update",
    );
    expect(changed).toBe(false);
  });

  test("update: returns true when value differs", async () => {
    const { app } = makeApp({ description: "old" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new",
      "update",
    );
    expect(changed).toBe(true);
  });

  test("keep: returns false when field already exists", async () => {
    const { app } = makeApp({ description: "existing" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new value",
      "keep",
    );
    expect(changed).toBe(false);
  });

  test("keep: returns true when field is absent", async () => {
    const { app } = makeApp({});
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "new value",
      "keep",
    );
    expect(changed).toBe(true);
  });
});
