import type { App, TFile } from "obsidian";
import { isEmptyValue } from "../emptyValue";

export async function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "append" | "replace" | "update" | "update_if_empty",
): Promise<boolean> {
  let changed = false;
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      const values = value as string[];
      const existing = frontmatter[key];
      // "Has something to merge with" is isEmptyValue, the same predicate
      // update_if_empty uses below — a second definition here diverged from it:
      // `existing != null` treated `tags: ""` and `tags: [""]` as content, so
      // String("") was seeded into the merge and the note ended up with a blank
      // tag alongside the generated ones.
      const base = isEmptyValue(existing)
        ? []
        : Array.isArray(existing)
          ? existing
          : [String(existing)];
      const merged = Array.from(new Set(base.concat(values)));
      // An empty append against an empty field is not a change: without this
      // the !Array.isArray(existing) term alone reported one, writing key: []
      // where nothing existed (#161).
      if (merged.length === 0 && isEmptyValue(existing)) return;
      changed =
        !Array.isArray(existing) ||
        base.length !== merged.length ||
        base.some((item, i) => item !== merged[i]);
      frontmatter[key] = merged;
    } else if (method === "replace") {
      // The array counterpart of "update", and the reason tags cannot simply
      // reuse it: "update" is typed for a scalar and would write the list as a
      // comma-joined string, after which Obsidian's tag pane stops indexing the
      // field (#230). Compared element-wise because a fresh array is never ===
      // the stored one, which would report a change on every run.
      const values = value as string[];
      const existing = frontmatter[key];
      const same =
        Array.isArray(existing) &&
        existing.length === values.length &&
        existing.every((item, i) => item === values[i]);
      if (same) return;
      // Writing [] where the field was already empty is not a change — the same
      // guard the append path needs (#161).
      if (values.length === 0 && isEmptyValue(existing)) return;
      changed = true;
      frontmatter[key] = values;
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
