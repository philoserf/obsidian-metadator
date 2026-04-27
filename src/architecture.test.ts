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
});
