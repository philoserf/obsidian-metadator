import { mock } from "bun:test";
import { obsidianDoubles } from "./testDom";

// Installed for every test file. A file needing a richer Modal re-mocks
// "obsidian" itself, spreading obsidianDoubles so the class identities — which
// instanceof depends on — stay the same across the whole run.
mock.module("obsidian", () => obsidianDoubles);
