import { describe, expect, test } from "bun:test";
import { stripSurroundingQuotes } from "./metadata";

describe("stripSurroundingQuotes", () => {
  test("unwraps a genuinely quoted title", () => {
    expect(stripSurroundingQuotes('"A Quoted Title"')).toBe("A Quoted Title");
    expect(stripSurroundingQuotes("'A Quoted Title'")).toBe("A Quoted Title");
  });

  test("leaves a title that merely opens and closes with quoted phrases", () => {
    // The old check was "first char is a quote and last char is a quote",
    // which this satisfies while not being a quoted string.
    expect(stripSurroundingQuotes('"Hello" and "Goodbye"')).toBe(
      '"Hello" and "Goodbye"',
    );
    expect(stripSurroundingQuotes("'Tis the season, said 'Bob'")).toBe(
      "'Tis the season, said 'Bob'",
    );
  });

  test("a different delimiter inside is not a reason to leave it wrapped", () => {
    expect(stripSurroundingQuotes(`"It's here"`)).toBe("It's here");
    expect(stripSurroundingQuotes(`'He said "hi"'`)).toBe('He said "hi"');
  });

  test("mismatched outer quotes are not a wrapper", () => {
    expect(stripSurroundingQuotes(`"Mixed'`)).toBe(`"Mixed'`);
  });

  test("a lone quote character is left alone", () => {
    // startsWith and endsWith are both true for a one-character string, and
    // substring(1, 0) silently returned the original rather than "".
    expect(stripSurroundingQuotes('"')).toBe('"');
    expect(stripSurroundingQuotes("'")).toBe("'");
  });

  test("an unquoted title is returned trimmed", () => {
    expect(stripSurroundingQuotes("  Plain Title  ")).toBe("Plain Title");
  });

  test("empty and whitespace input", () => {
    expect(stripSurroundingQuotes("")).toBe("");
    expect(stripSurroundingQuotes("   ")).toBe("");
  });

  test('unwraps to an empty string for ""', () => {
    expect(stripSurroundingQuotes('""')).toBe("");
  });
});
