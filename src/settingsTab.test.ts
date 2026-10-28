import { describe, expect, test } from "bun:test";
import type { App, SettingDefinition, SettingDefinitionGroup } from "obsidian";
import type MetadataToolPlugin from "./main";
import { DEFAULT_SETTINGS, PROMPT_MAX_LENGTH } from "./settings";
import {
  apiKeyStatus,
  createDebouncer,
  MetadataToolSettingTab,
} from "./settingsTab";

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

  test("cancel drops a pending commit without running it", async () => {
    let commits = 0;
    const d = createDebouncer(() => commits++, 20);

    d.schedule();
    d.cancel();
    d.flush();
    await tick(40);

    expect(commits).toBe(0);
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
    const app = { secretStorage: { listSecrets: () => [] } } as unknown as App;
    return { tab: new MetadataToolSettingTab(app, plugin), plugin };
  }

  test("an external reload drops a pending save, then re-renders (#292)", async () => {
    const saves: string[] = [];
    const { tab, plugin } = makeTab();
    plugin.saveSettings = async () => {
      saves.push(plugin.settings.descriptionFieldName);
    };
    const order: string[] = [];
    tab.update = () => order.push("update");

    tab.setControlValue("descriptionFieldName", "edited-here");
    await tab.reloadSettings(async () => {
      order.push("load");
      plugin.settings = { ...DEFAULT_SETTINGS, descriptionFieldName: "synced" };
    });
    tab.hide(); // flushes anything still pending
    await new Promise((r) => setTimeout(r, 0));

    // Without the cancel, hide() would write the adopted settings straight
    // back to the file Sync just delivered.
    expect(saves).toEqual([]);
    expect(order).toEqual(["load", "update"]);
  });

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
    tab.setControlValue("descriptionFieldName", "  summary  ");
    tab.setControlValue("descriptionPrompt", "");
    expect(plugin.settings.descriptionFieldName).toBe("summary");
    expect(plugin.settings.descriptionPrompt).toBe(
      DEFAULT_SETTINGS.descriptionPrompt,
    );
  });

  test("rejects colliding field names inline (#200)", async () => {
    const { tab } = makeTab();
    expect(await validate(tab, "descriptionFieldName", "title")).toBeTruthy();
    expect(
      await validate(tab, "descriptionFieldName", "summary"),
    ).toBeUndefined();
  });

  test("refuses a colliding title name even while titles are off (#248)", async () => {
    // migrateSettings would reset it on the very write that stored it.
    const { tab } = makeTab({ enableTitle: false });
    expect(await validate(tab, "titleFieldName", "description")).toBeTruthy();
  });

  test("rejects an over-long prompt inline", async () => {
    const { tab } = makeTab();
    expect(
      await validate(tab, "titlePrompt", "x".repeat(PROMPT_MAX_LENGTH + 1)),
    ).toBeTruthy();
    expect(await validate(tab, "titlePrompt", "short")).toBeUndefined();
  });

  test("bounds the content token limit (#184)", async () => {
    const { tab } = makeTab();
    expect(await validate(tab, "contentTokenLimit", 0)).toBeTruthy();
    expect(await validate(tab, "contentTokenLimit", 1.5)).toBeTruthy();
    expect(await validate(tab, "contentTokenLimit", 1e12)).toBeTruthy();
    expect(await validate(tab, "contentTokenLimit", 300)).toBeUndefined();
  });

  test("truncate and title toggles disable their dependent rows", () => {
    const { tab } = makeTab({ truncateContent: false, enableTitle: false });
    expect(isDisabled(tab, "contentTokenLimit")).toBe(true);
    expect(isDisabled(tab, "truncateMethod")).toBe(true);
    expect(isDisabled(tab, "titleFieldName")).toBe(true);
    expect(isDisabled(tab, "titlePrompt")).toBe(true);
    expect(isDisabled(tab, "titlePolicy")).toBe(true);
    expect(isDisabled(tab, "descriptionPrompt")).toBe(false);
  });

  test("each field has a toggle (#305)", () => {
    const { tab } = makeTab();
    for (const key of ["enableDescription", "enableTitle"]) {
      expect(control(tab, key).type).toBe("toggle");
    }
  });

  test("the description toggle disables the description name, prompt and policy (#305)", () => {
    const { tab } = makeTab({ enableDescription: false });
    expect(isDisabled(tab, "descriptionFieldName")).toBe(true);
    expect(isDisabled(tab, "descriptionPrompt")).toBe(true);
    expect(isDisabled(tab, "descriptionPolicy")).toBe(true);
    expect(isDisabled(tab, "titlePrompt")).toBe(false);
  });

  test("refuses a colliding description name even while it is off (#305)", async () => {
    const { tab } = makeTab({ enableDescription: false });
    expect(await validate(tab, "descriptionFieldName", "title")).toBeTruthy();
  });
});

// The row and Settings → Keychain are separate screens, and only the secret's
// name syncs — so the row has to say what the secret is called.
describe("apiKeyStatus", () => {
  test("suggests the shared name when nothing is chosen", () => {
    expect(apiKeyStatus("", [])).toContain('"anthropic-api-key"');
  });

  test("names the secret when this device has it", () => {
    expect(apiKeyStatus("anthropic-api-key", ["anthropic-api-key"])).toBe(
      'Uses the keychain secret "anthropic-api-key".',
    );
  });

  test("says what to add when this device does not", () => {
    const status = apiKeyStatus("anthropic-api-key", ["github-token"]);
    expect(status).toContain('no secret named "anthropic-api-key"');
    expect(status).toContain("Settings → Keychain");
  });
});
