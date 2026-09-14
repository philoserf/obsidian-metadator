import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokens";
import {
  truncateHeading,
  truncateHeadOnly,
  truncateHeadTail,
} from "./truncate";

// Assertion helper: the tokenizer returns {text, start, end} spans, but these
// tests only care about the text. No production caller wants this shape.
const splitIntoTokens = (s: string) => tokenize(s).map((t) => t.text);

describe("truncateHeadOnly", () => {
  const src = "one two three four five";

  test("returns first N tokens with ellipsis", () => {
    expect(truncateHeadOnly(src, tokenize(src), 3)).toBe("one two three...");
  });

  test("handles limit of 1", () => {
    expect(truncateHeadOnly(src, tokenize(src), 1)).toBe("one...");
  });

  test("returns all tokens when limit equals length", () => {
    const short = "one two three";
    expect(truncateHeadOnly(short, tokenize(short), 3)).toBe("one two three");
  });

  test("returns all tokens when limit exceeds length", () => {
    const short = "one two";
    expect(truncateHeadOnly(short, tokenize(short), 10)).toBe("one two");
  });

  test("keeps markdown syntax inside the kept span (#182)", () => {
    // The exact string from #182. Before the fix this returned
    // "# Title\n\nThis is bold and..." — every emphasis, link, and code
    // marker inside the kept span was deleted, not merely uncounted.
    const md =
      "# Title\n\nThis is **bold** and _italic_ text with a [link](http://example.com) and `code`.";
    const out = truncateHeadOnly(md, tokenize(md), 15);
    expect(out).toBe("# Title\n\nThis is **bold** and _italic_...");
  });

  test("keeps emoji inside the kept span (#182)", () => {
    const md = "alpha 😀 beta gamma delta";
    expect(truncateHeadOnly(md, tokenize(md), 3)).toBe("alpha 😀 beta...");
  });
});

describe("truncateHeadTail", () => {
  test("returns full content when limit covers all tokens", () => {
    const src = Array.from({ length: 10 }, (_, i) => `t${i}`).join(" ");
    const result = truncateHeadTail(src, tokenize(src), 10);
    expect(result).toBe(src);
    expect(result).not.toContain("...");
  });

  test("returns full content when limit exceeds token count", () => {
    const src = "a b c";
    const result = truncateHeadTail(src, tokenize(src), 100);
    expect(result).toBe(src);
    expect(result).not.toContain("...");
  });

  test("handles small limit", () => {
    const src = "a b c d e f g h i j";
    const result = truncateHeadTail(src, tokenize(src), 5);
    // 80% of 5 = 4, 20% of 5 = 1
    expect(result).toContain("a");
    expect(result).toContain("\n...\n");
  });

  test("handles limit of 1", () => {
    const src = "a b c d e";
    const result = truncateHeadTail(src, tokenize(src), 1);
    // All budget goes to head, tail is empty — no separator
    expect(result).toBe("a");
    expect(result).not.toContain("\n...\n");
  });

  test("keeps markdown in both halves (#182)", () => {
    const src = "**start** one two three four five six _end_";
    // left = floor(7 * 0.8) = 5 tokens (* * start * *), right = 2 (end _).
    const result = truncateHeadTail(src, tokenize(src), 7);
    expect(result).toContain("**start**");
    expect(result).toContain("end_");
  });
});

describe("truncateHeading", () => {
  test("extracts headings and first paragraph", () => {
    const content =
      "# Title\nSome paragraph text here for testing.\n\n## Section\nMore text in section.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
    expect(result).toContain("## Section");
    expect(result).toContain("Outline:");
    // No Body section: every source line is either a heading or a first
    // paragraph captured by the outline, so there is no remaining content.
    expect(result).not.toContain("Body:");
  });

  test("truncates when outline exceeds limit", () => {
    const content = "# H1\nParagraph one.\n# H2\nParagraph two.";
    const tokens = tokenize(content);
    // Very small limit to force truncation of the outline itself
    const result = truncateHeading(content, tokens, 2);
    // The "..." marker sits past the limit here, as it does in truncateHeadOnly
    // and truncateHeadTail — so the budget applies to the sliced outline, not
    // to the marker (#176).
    expect(result.endsWith("...")).toBe(true);
    const outlineTokens = splitIntoTokens(result.slice(0, -3));
    expect(outlineTokens.length).toBeLessThanOrEqual(2);
    // Should not contain the Outline:/Body: wrapper since outline exceeded limit
    expect(result).not.toContain("Outline:");
    expect(result).not.toContain("Body:");
  });

  test("filters empty lines", () => {
    const content = "# Title\n\n\n\nParagraph after blanks.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    expect(result).toContain("# Title");
    // The blank run is the gap before the paragraph, not a terminator.
    expect(result).toContain("Paragraph after blanks.");
  });

  test("does not append ellipsis to short paragraphs", () => {
    const content = "# Title\nShort paragraph.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    // "Short paragraph." is < 30 tokens, should not get "..."
    expect(result).toContain("Short paragraph.");
    expect(result).not.toMatch(/Short paragraph\.\.\.\./);
  });

  test("omits body when outline consumes entire budget", () => {
    // Outline for "# A\nword" is ["# A", "word"] → "# A\nword"
    // tokenized: ["#", "A", "\n", "word"] = 4 tokens
    // limit=4 → remainingTokens=0 → no body section
    const content = "# A\nword";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 4);
    expect(result).toContain("Outline:");
    expect(result).not.toContain("Body:");
  });

  test("handles content with no headings", () => {
    const content = "Just a plain paragraph with no headings at all.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 1000);
    // No headings → no outline to label, so no wrapper at all. This asserted
    // the presence of "Body:" until #168: an empty outline still emitted
    // "Outline: \n\n\nBody: ...", labelling real content with a heading list
    // that did not exist.
    expect(result).not.toContain("Body:");
    expect(result).not.toContain("Outline:");
    expect(result).toBe(content);
  });

  test("body does not duplicate outline content", () => {
    const content =
      "# Title\nFirst paragraph.\n\n## Section\nSecond paragraph.\n\nExtra content beyond the outline.";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 50);
    // Body should not start with the same tokens as the outline
    const bodyMatch = result.match(/Body:\s*(.*)/s);
    expect(bodyMatch).not.toBeNull();
    const bodyText = bodyMatch?.[1] ?? "";
    // The outline includes "# Title" so body should not start with "#"
    expect(bodyText.trimStart().startsWith("#")).toBe(false);
  });

  test("body does not repeat a paragraph pulled into the outline past a blank line", () => {
    // Blank line adds a \n token to the original but nothing to the outline.
    // Buggy offset (outline-token-count) undershoots, causing "word" — which
    // is already in the outline as the first paragraph — to reappear in body.
    const content = "# H\n\nword";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 5);
    const wordOccurrences = (result.match(/\bword\b/g) ?? []).length;
    expect(wordOccurrences).toBe(1);
    // …and the one occurrence is the outline's captured paragraph, not a body
    // that got it only because capture was cancelled by the blank line.
    expect(result).toContain("Outline: \n# H\nword");
  });

  test("omits body when remaining tokens render as empty after joinTokens", () => {
    // Trailing blank lines leave \n tokens past the last consumed line.
    // bodyTokens.length > 0 is insufficient because joinTokens trims whitespace
    // to an empty string. Body section must be omitted in that case.
    const content = "# H\nword\n\n";
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 10);
    expect(result).not.toContain("Body:");
  });

  test("body captures content after a truncated first paragraph", () => {
    // 31-word paragraph triggers the "..." suffix (3 extra tokens in outline).
    // Buggy offset overshoots the original stream and skips FINALWORD; fix
    // advances by source lines consumed, so body begins at FINALWORD.
    //
    // The blank line matters: without it FINALWORD is a soft-wrapped
    // continuation of the same paragraph and belongs to the outline, not the
    // body (#167).
    const paragraph = Array.from({ length: 31 }, (_, i) => `W${i + 1}`).join(
      " ",
    );
    const content = `# H\n${paragraph}\n\nFINALWORD`;
    const tokens = tokenize(content);
    const result = truncateHeading(content, tokens, 40);
    expect(result).toContain("Body:");
    expect(result).toContain("FINALWORD");
  });
});

describe("truncateHeading fenced code blocks", () => {
  // Only the outline is under test. The "Body:" section is the verbatim tail of
  // the document, so fenced code legitimately appears there — the bug was fence
  // content being promoted into the outline as headings and prose.
  function outline(content: string, limit = 1000) {
    const result = truncateHeading(content, tokenize(content), limit);
    return result.split("\n\nBody:")[0];
  }

  test("a # comment inside a fence is not a heading", () => {
    const content = [
      "# Real Heading",
      "Real paragraph.",
      "",
      "```python",
      "# this is a python comment, not a heading",
      "def foo():",
      "    pass",
      "```",
    ].join("\n");
    const result = outline(content);
    expect(result).toContain("# Real Heading");
    expect(result).toContain("Real paragraph.");
    expect(result).not.toContain("python comment");
    expect(result).not.toContain("def foo");
  });

  test("a heading after the fence closes is still a heading", () => {
    const content = [
      "```",
      "# not a heading",
      "```",
      "",
      "# After The Fence",
      "Its paragraph.",
    ].join("\n");
    const result = outline(content);
    expect(result).toContain("# After The Fence");
    expect(result).not.toContain("# not a heading");
  });

  test("a tilde fence works the same as a backtick fence", () => {
    const content = ["~~~", "# not a heading", "~~~", "# Real"].join("\n");
    const result = outline(content);
    expect(result).toContain("# Real");
    expect(result).not.toContain("# not a heading");
  });

  test("a backtick run inside a tilde fence does not close it", () => {
    const content = ["~~~", "```", "# still inside", "~~~", "# Real"].join(
      "\n",
    );
    const result = outline(content);
    expect(result).toContain("# Real");
    expect(result).not.toContain("# still inside");
  });

  test("a longer closing marker still closes the fence", () => {
    const content = ["```", "# inside", "````", "# Real"].join("\n");
    const result = outline(content);
    expect(result).toContain("# Real");
    expect(result).not.toContain("# inside");
  });

  test("an unterminated fence swallows the rest, as a markdown parser would", () => {
    const content = ["# Before", "```", "# inside", "# also inside"].join("\n");
    const result = outline(content);
    expect(result).toContain("# Before");
    expect(result).not.toContain("# also inside");
  });

  test("an indented fence is still a fence", () => {
    const content = ["  ```", "# inside", "  ```", "# Real"].join("\n");
    const result = outline(content);
    expect(result).toContain("# Real");
    expect(result).not.toContain("# inside");
  });
});

describe("truncateHeading paragraph accumulation", () => {
  function outline(content: string, limit = 1000) {
    return truncateHeading(content, tokenize(content), limit).split(
      "\n\nBody:",
    )[0];
  }

  test("a soft-wrapped paragraph is captured whole", () => {
    const content = [
      "# Heading",
      "First physical line of the paragraph",
      "second line that soft-wrapped",
      "and a third.",
      "",
      "Later content.",
    ].join("\n");
    const result = outline(content);
    expect(result).toContain("First physical line");
    expect(result).toContain("second line that soft-wrapped");
    expect(result).toContain("and a third.");
  });

  test("a blank line ends the paragraph", () => {
    const content = [
      "# Heading",
      "The paragraph.",
      "",
      "A second paragraph that should not be captured.",
    ].join("\n");
    const result = outline(content);
    expect(result).toContain("The paragraph.");
    expect(result).not.toContain("second paragraph");
  });

  test("the next heading ends the paragraph", () => {
    const content = ["# One", "Para one.", "# Two", "Para two."].join("\n");
    const result = outline(content);
    expect(result).toContain("Para one.");
    expect(result).toContain("# Two");
    expect(result).toContain("Para two.");
  });

  test("a fence ends the paragraph", () => {
    const content = ["# Heading", "The prose.", "```", "code()", "```"].join(
      "\n",
    );
    const result = outline(content);
    expect(result).toContain("The prose.");
    expect(result).not.toContain("code()");
  });

  test("the 30-token cap applies to the whole paragraph, not per line", () => {
    // Two lines of 20 words: under the old per-line rule the second line was
    // dropped entirely and neither hit the cap. Together they exceed it.
    const line = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const content = `# H\n${line}\n${line}`;
    const result = outline(content);
    expect(result).toContain("...");
    expect(result).toContain("w19");
  });

  test("a paragraph under the cap gets no ellipsis", () => {
    const content = "# H\nShort first line\nand a short second.";
    const result = outline(content);
    expect(result).toContain("and a short second.");
    expect(result).not.toContain("...");
  });

  test("a blank line between heading and paragraph does not cancel capture", () => {
    // The standard markdown layout. A blank line ends a paragraph that is
    // already accumulating, but one that arrives before the paragraph starts
    // is just the gap after the heading — treating it as a terminator left
    // every section in a conventionally formatted note with no prose at all.
    const content = ["# Heading", "", "The paragraph.", "", "Later."].join(
      "\n",
    );
    const result = outline(content);
    expect(result).toContain("The paragraph.");
    expect(result).not.toContain("Later.");
  });

  test("a captured paragraph does not emit a trailing blank line", () => {
    // A line's token span includes its terminating newline; slicing it into
    // the outline doubled up with the join and put a blank line after every
    // paragraph.
    const content = ["# One", "Para one.", "# Two", "Para two."].join("\n");
    expect(outline(content)).toBe(
      "Outline: \n# One\nPara one.\n# Two\nPara two.",
    );
  });

  test("a paragraph of exactly the cap gets no ellipsis", () => {
    // The terminating newline used to count toward PARAGRAPH_TOKEN_CAP, so a
    // paragraph at exactly the cap was marked truncated with nothing cut.
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const result = outline(`# H\n${words}\n\ntail`);
    expect(result).toContain("w29");
    expect(result).not.toContain("...");
  });
});

describe("truncateHeading without headings", () => {
  test("falls back to a plain head truncation, no empty Outline wrapper", () => {
    const content =
      "Just a plain paragraph with no headings anywhere in the note.";
    const result = truncateHeading(content, tokenize(content), 1000);
    expect(result).not.toContain("Outline:");
    expect(result).not.toContain("Body:");
    expect(result).toBe(content);
  });

  test("the fallback still honours the limit and marks truncation", () => {
    const content = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const result = truncateHeading(content, tokenize(content), 10);
    expect(result).not.toContain("Outline:");
    expect(result).toBe(truncateHeadOnly(content, tokenize(content), 10));
    expect(result.endsWith("...")).toBe(true);
  });

  test("a note whose only # is inside a fence has no outline either", () => {
    const content = ["```", "# not a heading", "```", "Body prose."].join("\n");
    const result = truncateHeading(content, tokenize(content), 1000);
    expect(result).not.toContain("Outline:");
    expect(result).toBe(content);
  });
});
