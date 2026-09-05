import type { App, TFile } from "obsidian";
import { isEmptyValue } from "../emptyValue";

export async function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "update_if_empty",
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
    } else if (method === "update_if_empty") {
      // `frontmatter` here is the live value at write time, not the caller's
      // pre-call snapshot. Under preserve_existing the generation request
      // can take up to a minute, during which the user may type into the very
      // field we are about to fill — re-checking here is what keeps that edit
      // from being overwritten.
      if (isEmptyValue(frontmatter[key])) {
        if (frontmatter[key] !== value) changed = true;
        frontmatter[key] = value;
      }
    }
  });
  return changed;
}
