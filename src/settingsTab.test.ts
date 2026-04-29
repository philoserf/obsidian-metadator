import { describe, expect, test } from "bun:test";
import { parseStrictPositiveInt } from "./settingsTab";

describe("parseStrictPositiveInt", () => {
  test("accepts positive integers", () => {
    expect(parseStrictPositiveInt("500")).toBe(500);
    expect(parseStrictPositiveInt("1")).toBe(1);
    expect(parseStrictPositiveInt("10000")).toBe(10000);
  });

  test("rejects zero", () => {
    expect(parseStrictPositiveInt("0")).toBeNull();
  });

  test("rejects negative numbers", () => {
    expect(parseStrictPositiveInt("-1")).toBeNull();
    expect(parseStrictPositiveInt("-100")).toBeNull();
  });

  test("rejects floats (no truncation)", () => {
    expect(parseStrictPositiveInt("1.5")).toBeNull();
    expect(parseStrictPositiveInt("0.9")).toBeNull();
  });

  test("rejects digit-prefixed strings (no prefix parsing)", () => {
    expect(parseStrictPositiveInt("100abc")).toBeNull();
    expect(parseStrictPositiveInt("12 ")).toBe(12);
    expect(parseStrictPositiveInt("12px")).toBeNull();
  });

  test("rejects non-numeric strings and empty input", () => {
    expect(parseStrictPositiveInt("abc")).toBeNull();
    expect(parseStrictPositiveInt("")).toBeNull();
    expect(parseStrictPositiveInt("   ")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(parseStrictPositiveInt(" 42 ")).toBe(42);
  });
});

describe("settingsTab validation logic", () => {
  describe("field name fallback", () => {
    function resolveFieldName(value: string, defaultName: string): string {
      return value || defaultName;
    }

    test("uses provided value when non-empty", () => {
      expect(resolveFieldName("custom-tags", "tags")).toBe("custom-tags");
    });

    test("falls back to default for empty string", () => {
      expect(resolveFieldName("", "tags")).toBe("tags");
      expect(resolveFieldName("", "description")).toBe("description");
      expect(resolveFieldName("", "title")).toBe("title");
    });
  });
});
