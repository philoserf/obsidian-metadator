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

  test("update_if_empty: writes when the live value is empty", async () => {
    const { app, fm } = makeApp({ description: "" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "generated",
      "update_if_empty",
    );
    expect(fm.description).toBe("generated");
    expect(changed).toBe(true);
  });

  test("update_if_empty: writes when the field is absent", async () => {
    const { app, fm } = makeApp({});
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "generated",
      "update_if_empty",
    );
    expect(fm.description).toBe("generated");
    expect(changed).toBe(true);
  });

  test("update_if_empty: leaves a populated live value alone", async () => {
    const { app, fm } = makeApp({ description: "user text" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "generated",
      "update_if_empty",
    );
    expect(fm.description).toBe("user text");
    expect(changed).toBe(false);
  });

  test("update_if_empty: treats a whitespace-only value as empty", async () => {
    const { app, fm } = makeApp({ description: "   " });
    await updateFrontMatter(
      app,
      {} as TFile,
      "description",
      "generated",
      "update_if_empty",
    );
    expect(fm.description).toBe("generated");
  });
});

describe("append with no values", () => {
  test("does not create an empty array where the field was absent", async () => {
    const { app, fm } = makeApp({});
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      [],
      "append",
    );
    expect("tags" in fm).toBe(false);
    expect(changed).toBe(false);
  });

  test("leaves an existing array untouched", async () => {
    const { app, fm } = makeApp({ tags: ["a", "b"] });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      [],
      "append",
    );
    expect(fm.tags).toEqual(["a", "b"]);
    expect(changed).toBe(false);
  });

  test("does not create an empty array where the field is blank", async () => {
    const { app, fm } = makeApp({ tags: "" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      [],
      "append",
    );
    expect(fm.tags).toBe("");
    expect(changed).toBe(false);
  });
});

describe("append onto a blank existing value", () => {
  // `existing != null` used to count these as content, so String(existing)
  // seeded a blank entry into the merge and the note kept an empty tag.
  test("an empty string is not merged in as a tag", async () => {
    const { app, fm } = makeApp({ tags: "" });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["ai", "testing"],
      "append",
    );
    expect(fm.tags).toEqual(["ai", "testing"]);
    expect(changed).toBe(true);
  });

  test("an array of blanks is not merged in as tags", async () => {
    const { app, fm } = makeApp({ tags: ["", "  "] });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["ai"],
      "append",
    );
    expect(fm.tags).toEqual(["ai"]);
    expect(changed).toBe(true);
  });

  test("a null value is not merged in as a tag", async () => {
    const { app, fm } = makeApp({ tags: null });
    const changed = await updateFrontMatter(
      app,
      {} as TFile,
      "tags",
      ["ai"],
      "append",
    );
    expect(fm.tags).toEqual(["ai"]);
    expect(changed).toBe(true);
  });
});
