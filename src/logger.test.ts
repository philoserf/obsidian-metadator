import { describe, expect, test } from "bun:test";
import { newRequestId } from "./logger";

describe("newRequestId", () => {
  test("returns an 8-character hex-ish string", () => {
    const id = newRequestId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("returns distinct ids on consecutive calls", () => {
    const ids = new Set([
      newRequestId(),
      newRequestId(),
      newRequestId(),
      newRequestId(),
      newRequestId(),
    ]);
    expect(ids.size).toBe(5);
  });
});
