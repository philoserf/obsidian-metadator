# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude with a forced `submit_metadata` tool call, validates the tool's structured input, and writes the results into the note's YAML frontmatter. A "Generate metadata (recursive)" folder action runs the same flow over a folder with confirm / progress / summary modals and a configurable hard cap on files-that-will-change.

This is single-user personal tooling, not a general-purpose community plugin — the README says so out loud: the only known installation is the maintainer's, breaking changes ship without migration paths, and feature requests from other users are out of scope.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-metadator` row). Read it when starting work; update it when that step ships.

## Development Commands

```bash
bun run dev              # Bundle in watch mode: unminified, linked sourcemap
bun run build            # check + bundle (this is what CI runs); minified, no sourcemap
bun run check            # tsc --noEmit, then biome check .
bun run lint:fix         # biome check --write .
bun test                 # whole suite
bun test src/bulkGenerate.test.ts        # one file
bun test -t "retry"                      # one test / describe by name pattern
bun run deploy           # Copy main.js + manifest.json to $OBSIDIAN_DEPLOY_DEST
bun run compare-models   # Send the same note to the live API once per configurable model
```

`compare-models` hits the live API and bills real tokens; it is not part of any check.

The `deploy` script reads `OBSIDIAN_DEPLOY_DEST` from `.env.local` (gitignored). Set it to the target plugin directory, e.g.:

```text
OBSIDIAN_DEPLOY_DEST=/absolute/path/to/vault/.obsidian/plugins/metadator
```

## Architecture

### Source Files

Most of `src/` is self-describing. These three exist in the shape they do for reasons the code cannot state:

- **[src/prompt.ts](src/prompt.ts)** — `buildPrompt`, `normalizeTags` and `readExistingTags`, pure functions with no Obsidian dependency. It stands on one leg now rather than two: `metadata.ts` no longer imports `obsidian` at runtime (#239 moved its last `Notice` out), so the original "without pulling in the Obsidian-runtime-only parts of `metadata.ts`" reason is spent. What remains is that one definition is shared by `metadata.ts` and `scripts/compare-models.ts`, which is reason enough not to fold it back.
- **[src/adapters/frontmatter.ts](src/adapters/frontmatter.ts)** — `updateFrontMatter` adapter over `app.fileManager.processFrontMatter`. Its `update_if_empty` method re-checks emptiness against the live frontmatter inside the callback, so a decision made before a slow API call cannot overwrite what the user typed during it.
- **[src/emptyValue.ts](src/emptyValue.ts)** — `isEmptyValue`, shared by the write-policy decision in `metadata.ts` and the write-time re-check in the frontmatter adapter. One definition, so the two cannot disagree.

### Key Patterns

- **Frontmatter updates** use `app.fileManager.processFrontMatter()` — not `parseYaml`/`stringifyYaml`
- **Token counting** uses a regex (`src/content/tokens.ts`) with per-character CJK/kana/hangul alternatives, Unicode word runs, nine punctuation marks, `\n`, and a trailing `\S` catch-all. The catch-all is load-bearing: without it emoji and markdown syntax match nothing and vanish from the count. Spaces and tabs stay uncounted on purpose, approximating how BPE tokenizers absorb whitespace into the following word.
- **Truncation reconstructs by slicing the source string**, never by re-joining token text. `tokenize` returns `{text, start, end}` and `sliceTokens(source, run)` returns the span. Re-joining would drop or re-space every character the counting regex sees individually — counting and reconstruction want opposite things from the same token array (#179, #182).
- **Truncation methods**: `head_only` (first N tokens), `head_tail` (80% start + 20% end), `heading` (outline + first paragraph per section, soft-wrapped continuations included)
- **Anthropic client** is initialized with `dangerouslyAllowBrowser: true` since it runs inside Obsidian's Electron renderer
- **Write policy is per field**, not global (#252): `tagsPolicy` (`regenerate` | `merge` | `preserve`), `descriptionPolicy` and `titlePolicy` (`regenerate` | `preserve`). One vocabulary across all three on purpose, so `regenerate` alone cannot say which write to use — `FieldUpdate` carries a `kind` (`list` | `scalar`) and `metadata.ts`'s `methodFor` maps the pair to an `updateFrontMatter` method: `regenerate`+`list`→`replace`, `regenerate`+`scalar`→`update`, `merge`→`append`, `preserve`→`update_if_empty`. `regenerate` is the only tags policy that can remove a tag, and it depends on the current tags being sent with the request (#251); `replace` exists because `update` is typed for a scalar and would write the list as a comma-joined string, after which Obsidian stops indexing the field (#230)
- **API calls** use a system message for instructions and wrap article content in XML tags in the user message. The tag name carries a per-request suffix (`<article-{requestId}>`) so note content cannot close the wrapper and have the remainder read as instructions (#204); `buildPrompt`'s third parameter defaults to plain `article` for scripts
- **Bulk retry policy**: rate-limit, overload, and connection errors (network blips and request timeouts) retry on the schedule `[2s, 8s, 30s]` (`DEFAULT_RETRY_DELAYS_MS`). Each delay is jittered to `[0.5x, 1.5x]` to avoid synchronized retry storms across parallel clients. If the SDK error carries a `Retry-After` header, that value is honored, capped at 2x the scheduled base delay so a misbehaving header can't stall a long bulk run. The SDK also performs its own internal retries — the outer policy applies on top of that. The whole policy lives in `src/retryPolicy.ts` — deliberately Obsidian-free, so it can be exercised from a plain `bun run` script, the same reason `prompt.ts` and `emptyValue.ts` sit on their own. It is one table, `RETRY_POLICY`, keyed by `HaltKind`: a kind present in it is retryable, `maxRetries` caps how much of the caller's schedule that kind takes (omitted means all of it, so a test's custom schedule is honored in full), and `haltStreak` overrides `DEFAULT_HALT_STREAK` (5). Connection is the one row with both overrides — 2 and 2. A hung socket burns the full request timeout on every one of the SDK's three attempts, so the full policy spent about an hour proving a dead network was dead (#221).
- **One run controller per plugin lifetime**: `onload` creates a single `AbortController` and `onunload` aborts it with reason `"plugin_unloaded"`; both entry points pass its signal down. `runBulkForFolder` does not reuse that signal directly — it makes a per-run controller, forwards the plugin signal into it, and _removes_ the forwarding listener in a `finally`, because the plugin signal outlives the run and would otherwise accumulate one listener (and one retained controller) per bulk run. `isAbortError` (`src/errors.ts`) is the single answer to "was this an abort?", because Electron's fetch rejects with a `DOMException` while the SDK throws a plain `Error` of the same name.
- **Per-file in-flight lock**: `src/inFlight.ts` is a module-level `Set` of paths, shared by the single-note command and the folder run — the one place they meet. Both snapshot frontmatter before a multi-second call and decide update-vs-keep from that snapshot, so an overlap means two billed calls whose result depends on write ordering. `generateMetadataForFile` captures `file.path` into `lockPath` _before_ the call and releases that: Obsidian mutates `TFile.path` in place on rename, so releasing `file.path` afterwards could free a different key and leak the original for the session.
- **Domain and presentation split, on both entry points.** `bulkOrchestrator.ts` is the UI shell for the folder run — key check, candidate collection, confirm modal, progress modal, abort wiring, summary modal; `bulkGenerate.ts` is its headless part, with no modal imports. `singleNote.ts` is the same shell for the command, and `metadata.ts` is the headless core both entry points call. Tests drive the headless modules directly; the shells' tests check wiring and rendering.

  `metadata.ts` renders nothing. It used to, behind a `bulk?: boolean` on `GenerateOptions`, and the two layers then collided: one failed frontmatter write produced four notices, the last calling it an "Unexpected error" — the wording reserved for `ClaudeApiError` kind `"unknown"` — which sent the user to check an API key that was fine (#239). Notices go down, prose goes up; neither belongs in the pipeline.

- **`FileResult.reason` is a closed union, not prose.** `SkipReason` has six members and two are load-bearing: `nothing_written` is the only skip that follows a *billed* API call, and `locked` the only one meaning "try again in a minute". The rule is **prose may be displayed, never matched** — the `"error"` arm still carries a free-form `reason` for display, and a renderer needing to know *which kind* of error occurred gets a typed carrier instead (`FrontmatterWriteError` in `errors.ts`, checked with `instanceof` beside `ClaudeApiError`). Not "not a `ClaudeApiError`, therefore a write failure": a `cachedRead` that throws inside `getContent` lands in the same catch.
- **Settings schema migrations**: `MetadataToolSettings.schemaVersion` is stamped onto every saved file. Migrations live in the `MIGRATIONS` map in `src/settingsMigrate.ts`, keyed by the version they produce. To add a migration, append the next version key + mutator and bump `CURRENT_SCHEMA_VERSION` in `settings.ts` — `applyMigrations` throws if a target version is missing its entry, so the bump-without-migration bug is caught at plugin-load time. `migrateSettings` returns a discriminated `MigrationResult` (`kind: "ok" | "missing" | "future"`); when `kind === "future"`, the plugin loads defaults but sets `futureSchemaBlocked` and `saveSettings()` refuses to write, surfacing a Notice instead of clobbering forward-version data.
- **Obsidian-free modules**: `prompt.ts`, `emptyValue.ts`, `errors.ts`, `retryPolicy.ts`, `metadata.ts` and everything under `content/` must not import `obsidian` at module scope. The package ships types with no runtime, so a module that imports it is reachable only under `bun test`'s preloaded mock — not from `scripts/`, and not from a `bun -e` demonstrating a pure function. Unlike the SDK boundary below, nothing enforces this mechanically; check with `grep -rn 'from "obsidian"' src --include='*.ts' | grep -v 'import type'`, which should list only modules that genuinely need the runtime.
- **SDK boundary**: `@anthropic-ai/sdk` may only be imported from `src/adapters/claude.ts`. This is enforced by Biome's `noRestrictedImports` rule in `biome.json`; other modules consume the adapter's typed wrapper (`callClaudeForMetadata`, `ClaudeApiError`) so SDK types do not leak into application or domain code. Test files are excluded from the rule because they reference the SDK module name for mocking — both `mock.module("@anthropic-ai/sdk", ...)` setups and dynamic `import()` calls used to access mocked SDK error constructors.
- **Structured logging**: when `debugLogging` is on, the request path emits structured records via `src/logger.ts` instead of prose. `logDebug` writes `console.log("[Metadator]", payload)` and `logError` writes `console.error("[Metadator]", payload)`. The payload always includes an `event` plus event-specific context drawn from `LogFields` — `file`, `model`, `requestId`, `attempt`, `durationMs`, `errorKind`, `errorMessage`, `errorName`, `errorStack`, `field`, `promptLength`, `contentLength` — rather than a single fixed set. A short hex `requestId` (`newRequestId`, 8 chars from `Math.random` — collisions are acceptable because the file path and event disambiguate, so there is deliberately no Web Crypto ladder) is minted per `addMetadataWithClaude` invocation, so a bulk retry produces a fresh requestId for each attempt; the file path is the cross-attempt joiner. Write-failure logs ride the same requestId so they correlate to the API call that produced the data. Vocabulary: `claude_request_start` / `claude_request_completed` / `claude_request_failed` (per call), `claude_retry_scheduled` (bulk retry loop), `frontmatter_write_failed`, `generation_failed`.

## Build System and CI

`main.js` is committed on purpose — Obsidian distributes the committed bundle, so any change to `src/` or to dependencies needs a rebuilt `main.js` committed alongside it.

CI (`.github/workflows/main.yml`) enforces that: it runs `bun run build` and then `git diff --exit-code main.js`, so a stale bundle fails the PR. Bun is deliberately unpinned (`bun-version: latest`), so a bun release that shifts bundler output trips the same check. The fix is identical either way — rebuild and commit `main.js`.

## Release Process

Use the `obsidian-gate` then `obsidian-ship` skills — do not tag by hand. Pushing any tag triggers `.github/workflows/release.yml`, which builds and attaches `main.js` + `manifest.json` to a GitHub release. Version numbers live in three files: `version-bump.ts` (wired to the `version` package script) is what propagates `package.json`'s version into `manifest.json` and adds the `version → minAppVersion` row to `versions.json`.

## Tests and Code Style

Style is enforced by Biome (`biome.json`).

Every test file is named for its source and sits beside it: `foo.ts` is covered by `foo.test.ts` in the same directory. Adding a test means extending that file, not starting a parallel one.

The single exception is **`bulkModals.test.ts`**, which covers modal _rendering_ for all three of `bulkConfirmModal.ts`, `bulkProgressModal.ts` and `bulkSummaryModal.ts` through one shared `FakeEl` fixture — splitting it would triplicate the fixture for no gain. `bulkConfirmModal.test.ts` and `bulkSummaryModal.test.ts` sit beside their sources as usual and cover only those files' pure helpers (`worstCaseApiCalls`, `groupErrors`).

This naming is what makes the `.claude/settings.json` `PostToolUse` hook work: it runs `${file%.ts}.test.ts` after an edit, so every source file's own suite runs. When a source file has no matching test the hook says so rather than exiting silently (#247) — today that names `main.ts` (the known gap behind #235/#245), `errors.ts` and `bulkProgressModal.ts`. The test doubles `test-preload.ts` and `testDom.ts` are excluded, since they will never have a suite of their own.

**Mocking contract**: `bunfig.toml` preloads `src/test-preload.ts`, which installs `mock.module("obsidian", () => obsidianDoubles)` for every test file. A test needing a richer `Modal` must re-mock `"obsidian"` while spreading `obsidianDoubles`, or the class identities `instanceof` depends on diverge for the rest of the run. `src/testDom.ts`'s `FakeEl` is a deliberate ~130-line stand-in for the slice of Obsidian's DOM helpers the modals use — chosen over happy-dom to keep the modal tests dependency-free.
