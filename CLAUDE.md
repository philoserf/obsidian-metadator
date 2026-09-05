# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude with a forced `submit_metadata` tool call, validates the tool's structured input, and writes the results into the note's YAML frontmatter. A "Generate metadata (recursive)" folder action runs the same flow over a folder with confirm / progress / summary modals and a configurable hard cap on files-that-will-change.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-metadator` row). Read it when starting work; update it when that step ships.

## Development Commands

Standard scripts are in `package.json`. The two with non-obvious effects:

```bash
bun run deploy           # Copy main.js + manifest.json to $OBSIDIAN_DEPLOY_DEST
bun run compare-models   # Send the same note to the live API once per configurable model
```

The `deploy` script reads `OBSIDIAN_DEPLOY_DEST` from `.env.local` (gitignored). Set it to the target plugin directory, e.g.:

```text
OBSIDIAN_DEPLOY_DEST=/absolute/path/to/vault/.obsidian/plugins/metadator
```

## Architecture

### Source Files

Most of `src/` is self-describing. These three exist in the shape they do for reasons the code cannot state:

- **[src/prompt.ts](src/prompt.ts)** — `buildPrompt` and `parseTags`, pure functions with no Obsidian dependency (unlike `metadata.ts`, which imports `obsidian` at module scope). Kept separate so they can be imported from a plain `bun run` script (e.g. `scripts/compare-models.ts`) without pulling in the Obsidian-runtime-only parts of `metadata.ts`.
- **[src/adapters/frontmatter.ts](src/adapters/frontmatter.ts)** — `updateFrontMatter` adapter over `app.fileManager.processFrontMatter`. Its `update_if_empty` method re-checks emptiness against the live frontmatter inside the callback, so a decision made before a slow API call cannot overwrite what the user typed during it.
- **[src/emptyValue.ts](src/emptyValue.ts)** — `isEmptyValue`, shared by the write-policy decision in `metadata.ts` and the write-time re-check in the frontmatter adapter. One definition, so the two cannot disagree.

### Key Patterns

- **Frontmatter updates** use `app.fileManager.processFrontMatter()` — not `parseYaml`/`stringifyYaml`
- **Token counting** uses a regex (`src/content/tokens.ts`) with per-character CJK/kana/hangul alternatives, Unicode word runs, nine punctuation marks, `\n`, and a trailing `\S` catch-all. The catch-all is load-bearing: without it emoji and markdown syntax match nothing and vanish from the count. Spaces and tabs stay uncounted on purpose, approximating how BPE tokenizers absorb whitespace into the following word.
- **Truncation reconstructs by slicing the source string**, never by re-joining token text. `tokenize` returns `{text, start, end}` and `sliceTokens(source, run)` returns the span. Re-joining would drop or re-space every character the counting regex sees individually — counting and reconstruction want opposite things from the same token array (#179, #182).
- **Truncation methods**: `head_only` (first N tokens), `head_tail` (80% start + 20% end), `heading` (outline + first paragraph per section)
- **Anthropic client** is initialized with `dangerouslyAllowBrowser: true` since it runs inside Obsidian's Electron renderer
- **Tags, description, and title** all respect `updateMethod` — preserve_existing keeps populated fields, always_regenerate updates all
- **API calls** use a system message for instructions and wrap article content in `<article>` XML tags in the user message
- **Bulk retry policy**: rate-limit and overload errors retry on the schedule `[2s, 8s, 30s]` (`DEFAULT_RETRY_DELAYS_MS`). Each delay is jittered to `[0.5x, 1.5x]` to avoid synchronized retry storms across parallel clients. If the SDK error carries a `Retry-After` header, that value is honored, capped at 2x the scheduled base delay so a misbehaving header can't stall a long bulk run. The SDK also performs its own internal retries — the outer policy applies on top of that.
- **Settings schema migrations**: `MetadataToolSettings.schemaVersion` is stamped onto every saved file. Migrations live in the `MIGRATIONS` map in `src/settingsMigrate.ts`, keyed by the version they produce. To add a migration, append the next version key + mutator and bump `CURRENT_SCHEMA_VERSION` in `settings.ts` — `applyMigrations` throws if a target version is missing its entry, so the bump-without-migration bug is caught at plugin-load time. `migrateSettings` returns a discriminated `MigrationResult` (`kind: "ok" | "missing" | "future"`); when `kind === "future"`, the plugin loads defaults but sets `futureSchemaBlocked` and `saveSettings()` refuses to write, surfacing a Notice instead of clobbering forward-version data.
- **SDK boundary**: `@anthropic-ai/sdk` may only be imported from `src/adapters/claude.ts`. This is enforced by Biome's `noRestrictedImports` rule in `biome.json`; other modules consume the adapter's typed wrapper (`callClaudeForMetadata`, `ClaudeApiError`) so SDK types do not leak into application or domain code. Test files are excluded from the rule because they reference the SDK module name for mocking — both `mock.module("@anthropic-ai/sdk", ...)` setups and dynamic `import()` calls used to access mocked SDK error constructors.
- **Structured logging**: when `debugLogging` is on, the request path emits structured records via `src/logger.ts` instead of prose. `logDebug` writes `console.log("[Metadator]", payload)` and `logError` writes `console.error("[Metadator]", payload)`. The payload always includes an `event` plus event-specific context drawn from `LogFields` — `file`, `model`, `requestId`, `attempt`, `durationMs`, `errorKind`, `errorMessage`, `errorName`, `errorStack`, `field`, `promptLength`, `contentLength` — rather than a single fixed set. A short hex `requestId` (`newRequestId`, 8 chars from `crypto.randomUUID` with `getRandomValues` and `Math.random` fallbacks for older WebViews) is minted per `addMetadataWithClaude` invocation, so a bulk retry produces a fresh requestId for each attempt; the file path is the cross-attempt joiner. Write-failure logs ride the same requestId so they correlate to the API call that produced the data. Vocabulary: `claude_request_start` / `claude_request_completed` / `claude_request_failed` (per call), `claude_retry_scheduled` (bulk retry loop), `frontmatter_write_failed`, `generation_failed`.

## Build System

`main.js` is committed to the repo — Obsidian distributes the committed bundle, so a build that isn't committed doesn't ship.

## Release Process

1. Update `package.json` version
2. Run `bun run version` to sync manifest.json and versions.json
3. Run `bun run build` and commit the rebuilt `main.js` — Obsidian distributes the committed bundle
4. Open PR and merge to `main` before tagging (tags must point at the merged commit)
5. Tag `X.Y.Z` on the merged commit and push tags — GitHub Actions creates the release

Pre-release: run `bun run check` and `bun run build`.

## Code Style

Enforced by Biome (`biome.json`). Tests are colocated with their source files in `src/`.
