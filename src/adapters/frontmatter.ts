import type { App, TFile } from "obsidian";

export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string[],
  method: "append",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean,
  method: "update",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "keep",
): Promise<boolean>;
export async function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): Promise<boolean> {
  let changed = false;
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      const values = value as string[];
      const existing = frontmatter[key];
      const base = Array.isArray(existing)
        ? existing
        : existing != null
          ? [String(existing)]
          : [];
      const merged = Array.from(new Set(base.concat(values)));
      changed =
        !Array.isArray(existing) ||
        base.length !== merged.length ||
        base.some((item, i) => item !== merged[i]);
      frontmatter[key] = merged;
    } else if (method === "update") {
      if (frontmatter[key] !== value) changed = true;
      frontmatter[key] = value;
    } else if (frontmatter[key] === undefined) {
      frontmatter[key] = value;
      changed = true;
    }
  });
  return changed;
}
