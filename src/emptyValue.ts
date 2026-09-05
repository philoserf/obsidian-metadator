// Shared emptiness predicate for frontmatter values. Lives on its own so both
// the write-policy decisions in metadata.ts and the write-time re-check in
// adapters/frontmatter.ts use one definition — they must agree, or a field can
// be judged empty when deciding to write and non-empty when writing.
// Deliberately not a falsiness check. `!value` folds 0, false and NaN in with
// "", and only "" belongs there: a frontmatter value of 0 or false is present
// and meaningful. Getting that wrong compounded across the two callers — a note
// with `title: 0` was judged empty by shouldGenerate, sent to the API under
// preserve_existing, then judged empty again by the update_if_empty re-check
// and overwritten, which is the exact outcome that re-check exists to prevent
// (#201). Numbers and booleans fall through to `return false`, matching how
// every other non-string scalar is already treated.
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((v) => String(v).trim() === "");
  }
  return false;
}
