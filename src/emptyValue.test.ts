import { describe, expect, test } from "bun:test";
import { isEmptyValue } from "./emptyValue";

describe("isEmptyValue", () => {
  test("null and undefined are empty", () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
  });

  test("a blank string is empty", () => {
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue("   ")).toBe(true);
    expect(isEmptyValue("\n\t")).toBe(true);
  });

  test("a string with content is not empty", () => {
    expect(isEmptyValue("x")).toBe(false);
    expect(isEmptyValue("  padded  ")).toBe(false);
  });

  test("an empty or blank array is empty", () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue([""])).toBe(true);
    expect(isEmptyValue(["", "  "])).toBe(true);
  });

  test("an array with any content is not empty", () => {
    expect(isEmptyValue(["a"])).toBe(false);
    expect(isEmptyValue(["", "a"])).toBe(false);
  });

  test("0 is a value, not an absence", () => {
    // Falsy, but present. Treating it as empty meant a note with `title: 0`
    // was regenerated and then overwritten under preserve_existing.
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(1)).toBe(false);
  });

  test("false is a value, not an absence", () => {
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(true)).toBe(false);
  });
});
