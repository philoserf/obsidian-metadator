import { describe, expect, test } from "bun:test";
import type { App, SettingDefinition, SettingDefinitionGroup } from "obsidian";
import type MetadataToolPlugin from "./main";
import { DEFAULT_SETTINGS, PROMPT_MAX_LENGTH } from "./settings";
import { createDebouncer, MetadataToolSettingTab } from "./settingsTab";

describe("createDebouncer (#177)", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("collapses a burst of keystrokes into one commit", async () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 20);

    for (let i = 0; i < 50; i++) d.schedule();
    expect(commits).toBe(0);

    await tick(40);
    expect(commits).toBe(1);
  });

  test("flush commits a pending change immediately", async () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 1_000);

    d.schedule();
    // Well inside the 1s window, so nothing has fired on its own yet.
    expect(commits).toBe(0);

    d.flush();

    // Observable without waiting out the delay, which is what "immediately"
    // means. Asserted on the commit counter rather than a pending() accessor:
    // that would check the implementation kept a timer variable, not that the
    // commit ran.
    expect(commits).toBe(1);

    await tick(20);
    expect(commits).toBe(1);
  });

  test("flush with nothing pending writes nothing", () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 20);

    d.flush();

    expect(commits).toBe(0);
  });

  test("flush cancels the timer, so the commit does not run twice", async () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 20);

    d.schedule();
    d.flush();
    await tick(40);

    // Left uncancelled, this would fire against a torn-down settings tab.
    expect(commits).toBe(1);
  });

  test("a later burst schedules again after a flush", async () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 20);

    d.schedule();
    d.flush();
    d.schedule();
    await tick(40);

    expect(commits).toBe(2);
  });
});

// The tab is data (#282), so it is tested as data: no DOM and no Obsidian.
describe("MetadataToolSettingTab", () => {
  function makeTab(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, ...overrides },
      saveSettings: async () => {},
    } as unknown as MetadataToolPlugin;
    return { tab: new MetadataToolSettingTab({} as App, plugin), plugin };
  }

  function rows(tab: MetadataToolSettingTab): SettingDefinition[] {
    return tab
      .getSettingDefinitions()
      .flatMap(
        (g) =>
          ((g as SettingDefinitionGroup).items ?? []) as SettingDefinition[],
      );
  }

  function control(tab: MetadataToolSettingTab, key: string) {
    for (const r of rows(tab)) {
      if ("control" in r && r.control?.key === key) return r.control;
    }
    throw new Error(`no control for ${key}`);
  }

  async function validate(
    tab: MetadataToolSettingTab,
    key: string,
    value: string | number,
  ) {
    const c = control(tab, key) as {
      validate?: (v: never) => string | undefined;
    };
    return (await c.validate?.(value as never)) || undefined;
  }

  function isDisabled(tab: MetadataToolSettingTab, key: string): boolean {
    const d = (control(tab, key) as { disabled?: boolean | (() => boolean) })
      .disabled;
    return typeof d === "function" ? d() : Boolean(d);
  }

  test("binds every persisted field but the key, model and version", () => {
    const { tab } = makeTab();
    const keys = rows(tab).flatMap((r) =>
      "control" in r && r.control ? [r.control.key] : [],
    );
    const handled = [
      "anthropicApiKeySecret",
      "anthropicModel",
      "schemaVersion",
    ];
    expect(keys.sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS)
        .filter((k) => !handled.includes(k))
        .sort(),
    );
  });

  test("the key and the model are rendered rows", () => {
    const { tab } = makeTab();
    for (const name of ["API key", "Model"]) {
      const r = rows(tab).find((x) => x.name === name);
      expect(r && "render" in r).toBe(true);
    }
  });

  test("writes go through migrateSettings, as a reload would", () => {
    const { tab, plugin } = makeTab();
    tab.setControlValue("tagsFieldName", "  keywords  ");
    tab.setControlValue("descriptionPrompt", "");
    expect(plugin.settings.tagsFieldName).toBe("keywords");
    expect(plugin.settings.descriptionPrompt).toBe(
      DEFAULT_SETTINGS.descriptionPrompt,
    );
  });

  test("rejects colliding field names inline (#200)", async () => {
    const { tab } = makeTab();
    expect(await validate(tab, "descriptionFieldName", "tags")).toBeTruthy();
    expect(
      await validate(tab, "descriptionFieldName", "summary"),
    ).toBeUndefined();
  });

  test("refuses a colliding title name even while titles are off (#248)", async () => {
    // migrateSettings would reset it on the very write that stored it.
    const { tab } = makeTab({ enableTitle: false });
    expect(await validate(tab, "titleFieldName", "tags")).toBeTruthy();
  });

  test("rejects an over-long prompt inline", async () => {
    const { tab } = makeTab();
    expect(
      await validate(tab, "tagsPrompt", "x".repeat(PROMPT_MAX_LENGTH + 1)),
    ).toBeTruthy();
    expect(await validate(tab, "tagsPrompt", "short")).toBeUndefined();
  });

  test("bounds the two numeric settings (#184)", async () => {
    const { tab } = makeTab();
    expect(await validate(tab, "maxBulkFiles", 0)).toBeTruthy();
    expect(await validate(tab, "maxBulkFiles", 1.5)).toBeTruthy();
    expect(await validate(tab, "maxBulkFiles", 1e12)).toBeTruthy();
    expect(await validate(tab, "maxBulkFiles", 300)).toBeUndefined();
  });

  test("truncate and title toggles disable their dependent rows", () => {
    const { tab } = makeTab({ truncateContent: false, enableTitle: false });
    expect(isDisabled(tab, "contentTokenLimit")).toBe(true);
    expect(isDisabled(tab, "truncateMethod")).toBe(true);
    expect(isDisabled(tab, "titleFieldName")).toBe(true);
    expect(isDisabled(tab, "titlePrompt")).toBe(true);
    expect(isDisabled(tab, "tagsPrompt")).toBe(false);
  });
});
