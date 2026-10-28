# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metadator is an Obsidian plugin that generates metadata (description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude with a `submit_metadata` tool call (forced via `tool_choice` where the model accepts it, `auto` plus an explicit instruction where it does not — see `usesAutoToolChoice`), validates the tool's structured input, and writes the results into the note's YAML frontmatter. There is no folder or bulk run (removed in #311), and no tag generation (removed in #310): the plugin neither reads nor writes `tags`. A `metadator:generate path=` CLI handler (`src/cli.ts`) runs it on one named file and prints the outcome as JSON, reading the frontmatter back from disk so the output is what the note holds.

This is single-user personal tooling, not a general-purpose community plugin — the README says so out loud: the only known installation is the maintainer's, breaking changes ship without migration paths, and feature requests from other users are out of scope.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-metadator` row). Read it when starting work; update it when that step ships.

## Development Commands

```bash
bun run build            # check + bundle (the gate; no CI) + install into the vault
bun test src/metadata.test.ts            # one file
bun test -t "preserve"                   # one test / describe by name pattern
bun run compare-models   # Send the same note to the live API once per configurable model
```

`compare-models` hits the live API and bills real tokens; it is not part of any check.

`bun run build` ends with `deploy.ts`, which copies `main.js` and `manifest.json` to `OBSIDIAN_DEPLOY_DEST` from `.env.local` (gitignored), or does nothing when it is unset. There is no separate deploy step. Set it to the target plugin directory, e.g.:

```text
OBSIDIAN_DEPLOY_DEST=/absolute/path/to/vault/.obsidian/plugins/metadator
```

## Architecture

### Source Files

Most of `src/` is self-describing. These three exist in the shape they do for reasons the code cannot state:

- **[src/prompt.ts](src/prompt.ts)** — `buildPrompt`, a pure function with no Obsidian dependency. It stays a separate module because one definition is shared by `metadata.ts` and `scripts/compare-models.ts`.
- **[src/adapters/frontmatter.ts](src/adapters/frontmatter.ts)** — `updateFrontMatter` adapter over `app.fileManager.processFrontMatter`. Its `update_if_empty` method re-checks emptiness against the live frontmatter inside the callback, so a decision made before a slow API call cannot overwrite what the user typed during it.
- **[src/emptyValue.ts](src/emptyValue.ts)** — `isEmptyValue`, shared by the write-policy decision in `metadata.ts` and the write-time re-check in the frontmatter adapter. One definition, so the two cannot disagree.

### Key Patterns

- **Frontmatter updates** use `app.fileManager.processFrontMatter()` — not `parseYaml`/`stringifyYaml`
- **Token counting** uses a regex (`src/content/tokens.ts`) with per-character CJK/kana/hangul alternatives, Unicode word runs, nine punctuation marks, `\n`, and a trailing `\S` catch-all. The catch-all is load-bearing: without it emoji and markdown syntax match nothing and vanish from the count. Spaces and tabs stay uncounted on purpose, approximating how BPE tokenizers absorb whitespace into the following word.
- **Truncation reconstructs by slicing the source string**, never by re-joining token text. `tokenize` returns `{text, start, end}` and `sliceTokens(source, run)` returns the span. Re-joining would drop or re-space every character the counting regex sees individually — counting and reconstruction want opposite things from the same token array (#179, #182).
- **Truncation methods**: `head_only` (first N tokens), `head_tail` (80% start + 20% end), `heading` (outline + first paragraph per section, soft-wrapped continuations included)
- **Anthropic client** is initialized with `dangerouslyAllowBrowser: true` since it runs inside Obsidian's Electron renderer
- **Fields are declared, not hand-wired** (#308). `settings.ts` lists `METADATA_FIELDS` and each one's keys (`FIELD_NAME_KEY`, `FIELD_ENABLE_KEY`, `FIELD_POLICY_KEY`, `FIELD_PROMPT_KEY`, `FIELD_LABEL`); the prompt, the tool schema, input validation, `shouldGenerate`, `planUpdates`, the CLI output and the field-name collision rule all loop over them. A field with an entry in `CHOICE_VALUES_KEY` is a **choice field**: its schema property is an enum of its configured values plus `NO_CHOICE` (`""`), and `validateMetadataInput` keeps a listed value and silently drops none, a missing value or an off-list one, never failing the request. `eyebrow` is the first; adding another (#309's `kind`) is a declaration there, its settings keys, a migration and settings-tab rows. The tab edits a choice list as one comma-separated line through `getControlValue`/`setControlValue`
- **Write policy is per field**, not global (#252): `descriptionPolicy`, `titlePolicy` and `eyebrowPolicy`, each `regenerate` | `preserve`. `metadata.ts` decides every write in `planUpdates` before making any, which is what lets `dry-run` (`GenerateOptions.dryRun`, its own `PreviewResult` type so the command can never get a preview) report the plan and stop; `writeField` maps `regenerate`→`update` and `preserve`→`update_if_empty`. Every write is a scalar: the list-valued path (`merge`, the array-typed `replace`, the current-tags reconciliation block) went with tag generation in #310
- **API calls** use a system message for instructions and wrap article content in XML tags in the user message. The tag name carries a per-request suffix (`<article-{requestId}>`) so note content cannot close the wrapper and have the remainder read as instructions (#204); `buildPrompt`'s third parameter defaults to plain `article` for scripts
- **Retries are the SDK's alone**: `SDK_MAX_RETRIES` (2) in `adapters/claude.ts`, pinned so a change is deliberate. A rate limit, overload or dropped connection is retried by the SDK and then surfaces as a `ClaudeApiError`; there is no outer retry schedule or halt policy since the folder run went (#311).
- **One run controller per plugin lifetime**: `onload` creates a single `AbortController` and `onunload` aborts it with reason `"plugin_unloaded"`; every entry point passes its signal down. `isAbortError` (`src/errors.ts`) is the single answer to "was this an abort?", because Electron's fetch rejects with a `DOMException` while the SDK throws a plain `Error` of the same name.
- **Per-file in-flight lock**: `src/inFlight.ts` is a module-level `Set` of paths, shared by the single-note command and the CLI handler — the one place they meet. Both snapshot frontmatter before a multi-second call and decide update-vs-keep from that snapshot, so an overlap means two billed calls whose result depends on write ordering. `generateMetadataForFile` captures `file.path` into `lockPath` _before_ the call and releases that: Obsidian mutates `TFile.path` in place on rename, so releasing `file.path` afterwards could free a different key and leak the original for the session.
- **Domain and presentation split, on every entry point.** `singleNote.ts` is the UI shell for the command, `cli.ts` for the CLI handler, and `metadata.ts` is the headless core both call. Tests drive the headless modules directly; the shells' tests check wiring and rendering.

  `metadata.ts` renders nothing. It used to, behind a `bulk?: boolean` on `GenerateOptions`, and the two layers then collided: one failed frontmatter write produced four notices, the last calling it an "Unexpected error" — the wording reserved for `ClaudeApiError` kind `"unknown"` — which sent the user to check an API key that was fine (#239). Notices go down, prose goes up; neither belongs in the pipeline.

- **`FileResult.reason` is a closed union, not prose.** `SkipReason` has six members and two are load-bearing: `nothing_written` is the only skip that follows a _billed_ API call, and `locked` the only one meaning "try again in a minute". The rule is **prose may be displayed, never matched** — the `"error"` arm still carries a free-form `reason` for display, and a renderer needing to know _which kind_ of error occurred gets a typed carrier instead (`FrontmatterWriteError` in `errors.ts`, checked with `instanceof` beside `ClaudeApiError`). Not "not a `ClaudeApiError`, therefore a write failure": a `cachedRead` that throws inside `getContent` lands in the same catch.
- **Settings schema migrations**: `MetadataToolSettings.schemaVersion` is stamped onto every saved file. Migrations live in the `MIGRATIONS` map in `src/settingsMigrate.ts`, keyed by the version they produce. To add a migration, append the next version key + mutator and bump `CURRENT_SCHEMA_VERSION` in `settings.ts` — `applyMigrations` throws if a target version is missing its entry, so the bump-without-migration bug is caught at plugin-load time. `migrateSettings` returns a discriminated `MigrationResult` (`kind: "ok" | "missing" | "future"`); when `kind === "future"`, the plugin loads defaults and blocks writes for the session, surfacing a Notice instead of clobbering forward-version data. The settings tab writes through `migrateSettings` too (its `setControlValue` override), so an edit stores exactly what a reload would produce; the tab is declarative (`getSettingDefinitions()`, Obsidian 1.13.0) and its tests assert on the definitions, not on DOM.

- **The API key is not a setting** (#281). `MetadataToolSettings` holds `anthropicApiKeySecret`, the ID of a secret in Obsidian's keychain; `main.ts`'s `config()` resolves it into a `MetadataConfig` when a command runs, and that is the type every consumer of the key accepts — it is never saved. A plaintext `anthropicApiKey` in `data.json`, at any schema version, is dropped by normalization, so a save cannot write it back; the one-time move into the keychain was removed on 2026-10-28, once no synced `data.json` carried one. Schema v4 exists so a v3 build syncing the file goes read-only instead of saving it back without the secret's ID; v5 does the same for the per-field toggles (#305), v6 for deleting the four tag settings when tag generation was removed (#310), and v7 for the eyebrow choice field (#308). The secret's _name_ syncs with `data.json` but its _value_ stays on the device that stored it, so the settings row's description comes from `apiKeyStatus` in `settingsTab.ts`, which reads names from `secretStorage.listSecrets()` — never a value — and tells a second device which secret to add (#289).

  What the plugin _does_ with that result is `decideLoad` / `decideSave` in `src/settingsStore.ts` — pure functions, so the rule "a newer `data.json` makes this install read-only" is testable without constructing a `Plugin` (`obsidian` is types-only, so anything that needs one cannot run under `bun test`). `main.ts` keeps the flag between the two calls and does the wiring. A synced `data.json` takes the same path: `onExternalSettingsChange` re-runs `loadSettings` through the tab's `reloadSettings`, which first _cancels_ the debounced save rather than flushing it, so adopting another device's settings is not a write that Sync carries back (#292). Be honest about the limit: the extraction covers the branches and the notice strings, not `main.ts` — the two assignments and the call still need a real `Plugin` and stay uncovered.

- **Obsidian-free modules**: `prompt.ts`, `emptyValue.ts`, `errors.ts`, `metadata.ts` and everything under `content/` must not import `obsidian` at module scope. The package ships types with no runtime, so a module that imports it is reachable only under `bun test`'s preloaded mock — not from `scripts/`, and not from a `bun -e` demonstrating a pure function. Unlike the SDK boundary below, nothing enforces this mechanically; check with `grep -rn 'from "obsidian"' src --include='*.ts' | grep -v 'import type'`, which should list only modules that genuinely need the runtime.
- **SDK boundary**: `@anthropic-ai/sdk` may only be imported from `src/adapters/claude.ts`. This is enforced by Biome's `noRestrictedImports` rule in `biome.json`; other modules consume the adapter's typed wrapper (`callClaudeForMetadata`, `ClaudeApiError`) so SDK types do not leak into application or domain code. Test files are excluded from the rule because they reference the SDK module name for mocking — both `mock.module("@anthropic-ai/sdk", ...)` setups and dynamic `import()` calls used to access mocked SDK error constructors.
- **Structured logging**: when `debugLogging` is on, the request path emits structured records via `src/logger.ts` instead of prose. `logDebug` writes `console.log("[Metadator]", payload)` and `logError` writes `console.error("[Metadator]", payload)`. The payload always includes an `event` plus event-specific context drawn from `LogFields` — `file`, `model`, `requestId`, `durationMs`, `errorKind`, `errorMessage`, `errorName`, `errorStack`, `field`, `promptLength`, `contentLength` — rather than a single fixed set. A short hex `requestId` (`newRequestId`, 8 chars from `Math.random` — collisions are acceptable because the file path and event disambiguate, so there is deliberately no Web Crypto ladder) is minted per `addMetadataWithClaude` invocation; the file path joins runs on the same note. Write-failure logs ride the same requestId so they correlate to the API call that produced the data. Vocabulary: `claude_request_start` / `claude_request_completed` / `claude_request_failed` (per call), `frontmatter_write_failed`, `generation_failed`.

## Build System

`main.js` is build output and gitignored. The vault gets it from `bun run build`, and a release attaches a fresh build, so nothing reads a committed copy. It was tracked until 2026-10-28; the reason given for tracking it (template #28, install from a GitHub checkout) does not apply to a plugin with one installation.

## Release Process

Use the `release-gate` then `release-ship` skills — do not tag by hand. Tags are bare semver (`1.2.3`) and must agree with `package.json`, `manifest.json` and `versions.json`; the release carries `main.js` + `manifest.json`. Version numbers live in three files: `version-bump.ts` (wired to the `version` package script) is what propagates `package.json`'s version into `manifest.json` and adds the `version → minAppVersion` row to `versions.json`.

## Tests and Code Style

Style is enforced by Biome (`biome.json`) for code and by `bun fmt` for markdown (Prettier-compatible; it reads `.prettierrc.json` and `.prettierignore`); `bun run check`, and so `bun run build`, runs `bun fmt --check` on every `.md` file.

`tsconfig.json` turns on `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Answer an indexed read with a narrowing local or `?.`, not `!`; an optional field filled from a value that may be undefined (a forwarded `signal`, a `LogFields` entry) is declared `?: T | undefined`.

Every test file is named for its source and sits beside it: `foo.ts` is covered by `foo.test.ts` in the same directory. Adding a test means extending that file, not starting a parallel one.

This naming is what makes the `.claude/settings.json` `PostToolUse` hook work: it runs `${file%.ts}.test.ts` after an edit, so every source file's own suite runs. When a source file has no matching test the hook says so rather than exiting silently (#247) — today that names `main.ts` (the known gap behind #235/#245) and `errors.ts`. The test doubles `test-preload.ts` and `testDom.ts` are excluded, since they will never have a suite of their own.

**Mocking contract**: `bunfig.toml` preloads `src/test-preload.ts`, which installs `mock.module("obsidian", () => obsidianDoubles)` for every test file. A test needing a richer double must re-mock `"obsidian"` while spreading `obsidianDoubles` (in `src/testDom.ts`, a name kept from when it held the modal DOM stand-ins), or the class identities `instanceof` depends on diverge for the rest of the run.
