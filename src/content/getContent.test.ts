import { describe, expect, test } from "bun:test";
import type { App, TFile } from "obsidian";
import { getContent } from "./getContent";

describe("getContent", () => {
  function makeVaultApp(content: string) {
    return {
      vault: { read: async () => content, cachedRead: async () => content },
    } as unknown as App;
  }

  // `method` is supplied but inert in both: getContent returns on limit <= 0
  // before it ever consults it.
  test("returns full content when limit is 0", async () => {
    const content = "Hello world, this is some content.";
    const app = makeVaultApp(content);
    const result = await getContent(app, {} as TFile, 0, "head_only");
    expect(result).toBe(content);
  });

  test("returns full content when limit is negative", async () => {
    const content = "Hello world, this is some content.";
    const app = makeVaultApp(content);
    const result = await getContent(app, {} as TFile, -1, "head_only");
    expect(result).toBe(content);
  });
});

describe("getContent frontmatter handling", () => {
  function appWith(content: string) {
    return {
      vault: { read: async () => content, cachedRead: async () => content },
    } as unknown as Parameters<typeof getContent>[0];
  }

  test("frontmatter does not spend the token budget", async () => {
    const frontmatter = `---\ntags: [${Array.from({ length: 60 }, (_, i) => `t${i}`).join(", ")}]\n---\n`;
    const body = "The article body that should survive truncation.";
    const result = await getContent(
      appWith(frontmatter + body),
      {} as never,
      20,
      "head_only",
    );
    expect(result).toContain("article body");
    expect(result).not.toContain("t59");
  });

  test("a frontmatter-only note yields nothing, not a YAML Body section", async () => {
    const result = await getContent(
      appWith("---\ntitle: Test\ntags: []\n---\n"),
      {} as never,
      1000,
      "heading",
    );
    expect(result).toBe("");
  });
});
