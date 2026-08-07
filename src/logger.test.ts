import { describe, expect, test } from "bun:test";
import { logDebug, logError, newRequestId } from "./logger";

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

describe("logDebug", () => {
  test("emits a single console.log call with [Metadator] prefix and the fields object", () => {
    const captured: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      logDebug({
        event: "claude_request_start",
        file: "note.md",
        model: "claude-sonnet-5",
        requestId: "abc12345",
      });
      expect(captured).toHaveLength(1);
      expect(captured[0][0]).toBe("[Metadator]");
      expect(captured[0][1]).toEqual({
        event: "claude_request_start",
        file: "note.md",
        model: "claude-sonnet-5",
        requestId: "abc12345",
      });
    } finally {
      console.log = original;
    }
  });
});

describe("logError", () => {
  test("emits a console.error call with [Metadator] prefix and the fields object", () => {
    const captured: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      logError({
        event: "frontmatter_write_failed",
        file: "note.md",
        field: "tags",
        errorMessage: "ENOENT",
      });
      expect(captured).toHaveLength(1);
      expect(captured[0][0]).toBe("[Metadator]");
      expect(captured[0][1]).toMatchObject({
        event: "frontmatter_write_failed",
        errorMessage: "ENOENT",
      });
    } finally {
      console.error = original;
    }
  });
});
