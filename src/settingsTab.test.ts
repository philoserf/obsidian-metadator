import { describe, expect, test } from "bun:test";
import { MAX_BULK_FILES } from "./settings";
import { parseBoundedPositiveInt } from "./settingsTab";

const parse = (v: string) => parseBoundedPositiveInt(v, MAX_BULK_FILES);

describe("parseBoundedPositiveInt", () => {
  test("accepts positive integers", () => {
    expect(parse("500")).toBe(500);
    expect(parse("1")).toBe(1);
    expect(parse("10000")).toBe(10000);
  });

  test("rejects zero", () => {
    expect(parse("0")).toBeNull();
  });

  test("rejects negative numbers", () => {
    expect(parse("-1")).toBeNull();
    expect(parse("-100")).toBeNull();
  });

  test("rejects floats (no truncation)", () => {
    expect(parse("1.5")).toBeNull();
    expect(parse("0.9")).toBeNull();
  });

  test("rejects digit-prefixed strings (no prefix parsing)", () => {
    expect(parse("100abc")).toBeNull();
    expect(parse("12 ")).toBe(12);
    expect(parse("12px")).toBeNull();
  });

  test("rejects non-numeric strings and empty input", () => {
    expect(parse("abc")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("   ")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(parse(" 42 ")).toBe(42);
  });

  test("rejects values above the ceiling", () => {
    expect(parse(String(MAX_BULK_FILES))).toBe(MAX_BULK_FILES);
    expect(parse(String(MAX_BULK_FILES + 1))).toBeNull();
  });

  test("rejects an all-digit paste that would lose precision", () => {
    // Number("99999999999999999999999999") is a finite double greater than
    // zero, so "positive integer" alone accepted it (#184).
    expect(parse("99999999999999999999999999")).toBeNull();
  });
});
