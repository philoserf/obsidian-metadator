// Obsidian returns the raw file from vault reads, frontmatter included, and the
// prompt only ever wants the note body. Left in, a note with many properties
// and a long existing tag list spends its whole token budget on YAML before any
// prose is considered — and under the `heading` strategy that YAML is handed to
// the model inside a "Body:" section as though it were prose (#164).
//
// This mirrors the contract of Obsidian's own getFrontMatterInfo rather than
// calling it: the obsidian package is types-only, so a test could only exercise
// a mock of that helper, never the code that ships.
//
// The rule, matching Obsidian: a block counts as frontmatter only when the file
// opens with `---` on its own first line, and it ends at the first later line
// that is exactly `---` or `...`.
const OPENING = /^---\r?(?:\n|$)/;
const CLOSING = /^(?:---|\.\.\.)\s*$/;

export function stripFrontMatter(content: string): string {
  if (!OPENING.test(content)) return content;

  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (CLOSING.test(lines[i].replace(/\r$/, ""))) {
      return lines.slice(i + 1).join("\n");
    }
  }

  // Unterminated: an opening `---` with no close is not a frontmatter block.
  // Treating it as one would swallow the entire note.
  return content;
}
