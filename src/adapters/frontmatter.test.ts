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
