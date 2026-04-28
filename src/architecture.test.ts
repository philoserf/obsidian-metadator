import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("architecture boundaries", () => {
  test("metadata does not depend on a utils dumping-ground module", () => {
    const srcDir = join(import.meta.dir);
    const metadata = readFileSync(join(srcDir, "metadata.ts"), "utf8");

    expect(metadata).not.toMatch(/\bfrom\s+["']\.\/utils["']/);
    expect(existsSync(join(srcDir, "utils.ts"))).toBe(false);
  });

  test("only the claude adapter imports the Anthropic SDK", () => {
    const srcDir = join(import.meta.dir);
    const sdkImporters = [
      "metadata.ts",
      "bulkGenerate.ts",
      "bulkOrchestrator.ts",
      "main.ts",
      "settings.ts",
      "settingsTab.ts",
    ];
    for (const file of sdkImporters) {
      const source = readFileSync(join(srcDir, file), "utf8");
      expect(source).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    }
  });
});
