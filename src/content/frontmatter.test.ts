import { describe, expect, test } from "bun:test";
import { stripFrontMatter } from "./frontmatter";

describe("stripFrontMatter", () => {
  test("removes a leading frontmatter block", () => {
    expect(
      stripFrontMatter("---\ntitle: Test\ntags: []\n---\nBody text."),
    ).toBe("Body text.");
  });

  test("leaves a note with no frontmatter untouched", () => {
    expect(stripFrontMatter("# Heading\n\nBody text.")).toBe(
      "# Heading\n\nBody text.",
    );
  });

  test("ignores a --- that is not on the first line", () => {
    const content = "Intro paragraph.\n\n---\nnot: frontmatter\n---\nMore.";
    expect(stripFrontMatter(content)).toBe(content);
  });

  test("leaves an unterminated block alone rather than swallowing the note", () => {
    const content = "---\ntitle: Test\n\nBody that never closes the block.";
    expect(stripFrontMatter(content)).toBe(content);
  });

  test("accepts ... as a closing marker", () => {
    expect(stripFrontMatter("---\ntitle: Test\n...\nBody.")).toBe("Body.");
  });

  test("tolerates CRLF line endings", () => {
    expect(stripFrontMatter("---\r\ntitle: Test\r\n---\r\nBody.")).toBe(
      "Body.",
    );
  });

  test("a frontmatter-only note strips to nothing", () => {
    expect(stripFrontMatter("---\ntitle: Test\ntags: []\n---\n").trim()).toBe(
      "",
    );
  });

  test("keeps a horizontal rule that appears later in the body", () => {
    expect(stripFrontMatter("---\na: 1\n---\nBefore\n\n---\n\nAfter")).toBe(
      "Before\n\n---\n\nAfter",
    );
  });

  test("does not treat a --- with trailing text as an opening", () => {
    const content = "--- not frontmatter\nbody\n---\n";
    expect(stripFrontMatter(content)).toBe(content);
  });
});
