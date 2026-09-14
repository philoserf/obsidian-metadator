import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from "./settings";
import type { MigrationResult } from "./settingsMigrate";
import { decideLoad, decideSave } from "./settingsStore";

// The guard these cover is the only thing standing between a downgrade — or a
// vault synced across two plugin versions — and a newer configuration being
// overwritten with this build's defaults. There is no backup behind it, and
// until this module existed it was unreachable from a test (#235, #245).
describe("decideLoad", () => {
  test("a newer data.json blocks writes and says why", () => {
    const decision = decideLoad({
      kind: "future",
      loadedSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
    });

    expect(decision.writesBlocked).toBe(true);
    expect(decision.settings).toEqual(DEFAULT_SETTINGS);
    expect(decision.notice).toContain(`v${CURRENT_SCHEMA_VERSION + 1}`);
    expect(decision.notice).toContain("won't be saved");
  });

  test("an in-version load leaves writes enabled and keeps the settings", () => {
    const loaded = { ...DEFAULT_SETTINGS, tagsFieldName: "keywords" };
    const decision = decideLoad({ kind: "ok", settings: loaded });

    expect(decision.writesBlocked).toBe(false);
    expect(decision.settings.tagsFieldName).toBe("keywords");
    expect(decision.notice).toBeUndefined();
  });

  // The flag's other end, and the branch most likely to be got wrong by a
  // later edit: a successful load after a blocked one must re-enable writing.
  test("a successful load after a blocked one re-enables writing", () => {
    const blocked = decideLoad({
      kind: "future",
      loadedSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
    });
    const recovered = decideLoad({ kind: "ok", settings: DEFAULT_SETTINGS });

    expect(blocked.writesBlocked).toBe(true);
    expect(recovered.writesBlocked).toBe(false);
  });

  test("a missing data.json is defaults, not blocked", () => {
    const decision = decideLoad({ kind: "missing" });

    expect(decision.writesBlocked).toBe(false);
    expect(decision.settings).toEqual(DEFAULT_SETTINGS);
    expect(decision.notice).toBeUndefined();
  });

  test("the returned settings are a copy, not the caller's object", () => {
    const loaded = { ...DEFAULT_SETTINGS };
    const decision = decideLoad({ kind: "ok", settings: loaded });
    decision.settings.tagsFieldName = "mutated";

    expect(loaded.tagsFieldName).toBe(DEFAULT_SETTINGS.tagsFieldName);
  });

  test("every MigrationResult kind is handled", () => {
    const kinds: MigrationResult[] = [
      { kind: "ok", settings: DEFAULT_SETTINGS },
      { kind: "missing" },
      { kind: "future", loadedSchemaVersion: 99 },
    ];

    for (const result of kinds) {
      expect(decideLoad(result).settings).toBeDefined();
    }
  });
});

describe("decideSave", () => {
  test("refuses while writes are blocked, and says what to do", () => {
    const decision = decideSave(true);

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.notice).toContain("newer plugin version");
      expect(decision.notice).toContain("data.json");
    }
  });

  test("writes when they are not blocked", () => {
    expect(decideSave(false)).toEqual({ kind: "write" });
  });
});
