import { describe, expect, test } from "bun:test";
import {
  areFieldNamesDistinct,
  DEFAULT_SETTINGS,
  isModelId,
  MAX_BULK_FILES,
  MAX_CONTENT_TOKEN_LIMIT,
  PROMPT_MAX_LENGTH,
} from "./settings";

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

describe("DEFAULT_SETTINGS satisfies its own validators", () => {
  // A default that violates a rule the settings tab enforces is a trap: the UI
  // shows the value but refuses to save it back, and migrateSettings falls back
  // to a default that is itself invalid.
  const prompts = [
    ["tagsPrompt", DEFAULT_SETTINGS.tagsPrompt],
    ["descriptionPrompt", DEFAULT_SETTINGS.descriptionPrompt],
    ["titlePrompt", DEFAULT_SETTINGS.titlePrompt],
  ] as const;

  for (const [name, value] of prompts) {
    test(`${name} is non-empty and within PROMPT_MAX_LENGTH`, () => {
      expect(value.trim()).not.toBe("");
      expect(value.length).toBeLessThanOrEqual(PROMPT_MAX_LENGTH);
    });
  }

  test("the numeric defaults are within their ceilings", () => {
    expect(DEFAULT_SETTINGS.maxBulkFiles).toBeLessThanOrEqual(MAX_BULK_FILES);
    expect(DEFAULT_SETTINGS.contentTokenLimit).toBeLessThanOrEqual(
      MAX_CONTENT_TOKEN_LIMIT,
    );
  });

  test("the default model is a well-formed model id", () => {
    expect(isModelId(DEFAULT_SETTINGS.anthropicModel)).toBe(true);
  });
});
