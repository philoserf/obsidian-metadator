import { describe, expect, test } from "bun:test";
import {
  anyFieldEnabled,
  areFieldNamesDistinct,
  DEFAULT_SETTINGS,
  enabledFields,
  isModelId,
  MAX_CONTENT_TOKEN_LIMIT,
  PROMPT_MAX_LENGTH,
} from "./settings";

type FieldNames = Parameters<typeof areFieldNamesDistinct>[0];

// Typed to the function's own parameter, so a typo'd override key is a compile
// error rather than a test that passes without exercising anything.
const names = (over: Partial<FieldNames> = {}): FieldNames => ({
  descriptionFieldName: "description",
  titleFieldName: "title",
  enableDescription: true,
  enableTitle: true,
  ...over,
});

describe("areFieldNamesDistinct", () => {
  test("the defaults are distinct", () => {
    expect(areFieldNamesDistinct(DEFAULT_SETTINGS)).toBe(true);
  });

  test("two different names pass", () => {
    expect(areFieldNamesDistinct(names())).toBe(true);
  });

  test("a colliding pair fails", () => {
    expect(
      areFieldNamesDistinct(names({ titleFieldName: "description" })),
    ).toBe(false);
  });
});

describe("DEFAULT_SETTINGS satisfies its own validators", () => {
  // A default that violates a rule the settings tab enforces is a trap: the UI
  // shows the value but refuses to save it back, and migrateSettings falls back
  // to a default that is itself invalid.
  const prompts = [
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
    expect(DEFAULT_SETTINGS.contentTokenLimit).toBeLessThanOrEqual(
      MAX_CONTENT_TOKEN_LIMIT,
    );
  });

  test("the default model is a well-formed model id", () => {
    expect(isModelId(DEFAULT_SETTINGS.anthropicModel)).toBe(true);
  });
});

// titleFieldName is inert when title generation is off — shouldGenerate does
// not consult it, buildPrompt omits the title instruction, and the write loop
// never queues a title update. A stale value there cannot clobber anything, so
// treating it as a collision destroyed valid settings to fix one nothing reads
// (#248). The same holds for any disabled field (#305).
describe("areFieldNamesDistinct with a field off", () => {
  test("a colliding but inert titleFieldName is not a collision", () => {
    expect(
      areFieldNamesDistinct(
        names({ enableTitle: false, titleFieldName: "description" }),
      ),
    ).toBe(true);
  });

  test("a colliding but inert descriptionFieldName is not a collision", () => {
    expect(
      areFieldNamesDistinct(
        names({ enableDescription: false, descriptionFieldName: "title" }),
      ),
    ).toBe(true);
  });

  test("with both fields on it is a collision again", () => {
    expect(
      areFieldNamesDistinct(
        names({ enableTitle: true, titleFieldName: "description" }),
      ),
    ).toBe(false);
  });
});

describe("enabledFields (#305)", () => {
  test("both are on by default", () => {
    expect([...enabledFields(DEFAULT_SETTINGS)]).toEqual([
      "description",
      "title",
    ]);
    expect(anyFieldEnabled(DEFAULT_SETTINGS)).toBe(true);
  });

  test("lists only the fields switched on, in prompt order", () => {
    expect([
      ...enabledFields({ enableDescription: false, enableTitle: true }),
    ]).toEqual(["title"]);
  });

  test("with both off there is nothing to generate", () => {
    const off = { enableDescription: false, enableTitle: false };
    expect(enabledFields(off).size).toBe(0);
    expect(anyFieldEnabled(off)).toBe(false);
  });
});
