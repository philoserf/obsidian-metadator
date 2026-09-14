import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import type { MigrationResult } from "./settingsMigrate";

// What the plugin should do with a MigrationResult, as a pure function of it.
//
// This is policy — *a newer data.json makes this install read-only* — and it is
// the only thing standing between a downgrade, or a vault synced across two
// plugin versions, and a newer configuration being overwritten with this
// build's defaults. There is no backup and no undo behind it.
//
// It lived as mutable private state on the Plugin subclass, and `obsidian` is a
// types-only package with no runtime, so the decision could not be reached from
// a test without constructing a Plugin. That is why main.ts was the one module
// in the repository with no test at all (#235, #245).
//
// Be clear about what moving it buys: these branches and notice strings are now
// directly testable, but main.ts itself is not. Assigning writesBlocked to the
// field, and saveSettings consulting it, still need a real Plugin and stay
// uncovered. The residue is two assignments and a call — thin, but not zero.

export interface LoadDecision {
  settings: MetadataToolSettings;
  writesBlocked: boolean;
  notice?: string;
}

export function decideLoad(result: MigrationResult): LoadDecision {
  if (result.kind === "ok") {
    return { settings: { ...result.settings }, writesBlocked: false };
  }
  if (result.kind === "future") {
    return {
      settings: { ...DEFAULT_SETTINGS },
      // The load that matters: block writes for the rest of the session.
      writesBlocked: true,
      notice: `Metadator settings were written by a newer plugin version (schema v${result.loadedSchemaVersion}). Settings won't be saved until you upgrade the plugin to avoid corrupting your data.`,
    };
  }
  // "missing" is a fresh install or an unreadable file — defaults, and writes
  // stay enabled. Clearing the flag here is what lets a blocked session
  // recover if data.json is later removed.
  return { settings: { ...DEFAULT_SETTINGS }, writesBlocked: false };
}

export type SaveDecision =
  | { kind: "write" }
  | { kind: "refuse"; notice: string };

export function decideSave(writesBlocked: boolean): SaveDecision {
  if (writesBlocked) {
    return {
      kind: "refuse",
      notice:
        "Refusing to save: settings file is from a newer plugin version. Upgrade the plugin or delete data.json to proceed.",
    };
  }
  return { kind: "write" };
}
