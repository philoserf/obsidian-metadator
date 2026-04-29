import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProductionTsFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (entry.name === "test-preload.ts") continue;
    out.push(full);
  }
  return out;
}

describe("architecture boundaries", () => {
  test("metadata does not depend on a utils dumping-ground module", () => {
    const srcDir = join(import.meta.dir);
    const metadata = readFileSync(join(srcDir, "metadata.ts"), "utf8");

    expect(metadata).not.toMatch(/\bfrom\s+["']\.\/utils["']/);
    expect(existsSync(join(srcDir, "utils.ts"))).toBe(false);
  });

  test("only the claude adapter imports the Anthropic SDK", () => {
    const srcDir = join(import.meta.dir);
    const adapter = join(srcDir, "adapters", "claude.ts");
    const sdkImportRegex = /from\s+["']@anthropic-ai\/sdk["']/;

    const offenders = listProductionTsFiles(srcDir)
      .filter((file) => file !== adapter)
      .filter((file) => sdkImportRegex.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcDir, file));

    expect(offenders).toEqual([]);
  });
});
