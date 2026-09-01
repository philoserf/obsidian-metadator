// Shared emptiness predicate for frontmatter values. Lives on its own so both
// the write-policy decisions in metadata.ts and the write-time re-check in
// adapters/frontmatter.ts use one definition — they must agree, or a field can
// be judged empty when deciding to write and non-empty when writing.
export function isEmptyValue(value: unknown): boolean {
  if (!value) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((v) => String(v).trim() === "");
  }
  return false;
}
