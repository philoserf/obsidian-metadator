import { beforeEach, describe, expect, test } from "bun:test";
import { acquire, clearInFlight, isInFlight, release } from "./inFlight";

describe("inFlight", () => {
  beforeEach(() => clearInFlight());

  test("the first acquire wins and the second is refused", () => {
    expect(acquire("a.md")).toBe(true);
    expect(acquire("a.md")).toBe(false);
  });

  test("different paths do not block each other", () => {
    expect(acquire("a.md")).toBe(true);
    expect(acquire("b.md")).toBe(true);
  });

  test("release makes the path acquirable again", () => {
    acquire("a.md");
    release("a.md");
    expect(isInFlight("a.md")).toBe(false);
    expect(acquire("a.md")).toBe(true);
  });

  test("releasing a path that was never acquired is harmless", () => {
    expect(() => release("ghost.md")).not.toThrow();
  });

  test("clearInFlight drops everything", () => {
    acquire("a.md");
    acquire("b.md");
    clearInFlight();
    expect(isInFlight("a.md")).toBe(false);
    expect(isInFlight("b.md")).toBe(false);
  });
});
