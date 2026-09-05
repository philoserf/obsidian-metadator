import { describe, expect, test } from "bun:test";
import { areFieldNamesDistinct, DEFAULT_SETTINGS } from "./settings";

type FieldNames = Parameters<typeof areFieldNamesDistinct>[0];

// Typed to the function's own parameter, so a typo'd override key is a compile
// error rather than a test that passes without exercising anything.
const names = (over: Partial<FieldNames> = {}): FieldNames => ({
  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",
  ...over,
});

describe("areFieldNamesDistinct", () => {
  test("the defaults are distinct", () => {
    expect(areFieldNamesDistinct(DEFAULT_SETTINGS)).toBe(true);
  });

  test("three different names pass", () => {
    expect(areFieldNamesDistinct(names())).toBe(true);
  });

  test("any colliding pair fails", () => {
    expect(areFieldNamesDistinct(names({ descriptionFieldName: "tags" }))).toBe(
      false,
    );
    expect(areFieldNamesDistinct(names({ titleFieldName: "tags" }))).toBe(
      false,
    );
    expect(
      areFieldNamesDistinct(names({ titleFieldName: "description" })),
    ).toBe(false);
  });

  test("all three colliding fails", () => {
    expect(
      areFieldNamesDistinct(
        names({ descriptionFieldName: "tags", titleFieldName: "tags" }),
      ),
    ).toBe(false);
  });
});
