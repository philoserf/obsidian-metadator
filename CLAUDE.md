# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude with a forced `submit_metadata` tool call, validates the tool's structured input, and writes the results into the note's YAML frontmatter. A "Generate metadata (recursive)" folder action runs the same flow over a folder with confirm / progress / summary modals and a configurable hard cap on files-that-will-change.

## Development Commands

```bash
bun install              # Install dependencies
bun run dev              # Watch mode with auto-rebuild
bun run build            # Production build (runs check first)
bun run check            # Run all checks (typecheck + biome)
bun run typecheck        # TypeScript type checking only
bun run lint             # Biome lint + format check
bun run lint:fix         # Auto-fix lint and format issues
bun run format           # Format code with Biome
bun run version          # Sync package.json version to manifest.json + versions.json
bun test                 # Run tests
bun test src/metadata.test.ts            # Run a single test file
bun test --test-name-pattern "parses"    # Filter tests by name
bun run deploy           # Copy main.js + manifest.json to $OBSIDIAN_METADATOR_DEST
```

The `deploy` script reads `OBSIDIAN_METADATOR_DEST` from `.env.local` (gitignored). Set it to the target plugin directory, e.g.:

```text
OBSIDIAN_METADATOR_DEST=/absolute/path/to/vault/.obsidian/plugins/metadator
```

## Architecture

### Source Files

- **[src/main.ts](src/main.ts)** — Plugin entry point. Registers the `generate-metadata` command and the folder-menu "Generate metadata (recursive)" item, owns lifecycle + settings load/save (with refusal-to-save when a forward-version data file is detected).
- **[src/settings.ts](src/settings.ts)** — `MetadataToolSettings` interface, `DEFAULT_SETTINGS`, `CURRENT_SCHEMA_VERSION`, valid-option enums (models, truncate methods, update methods), and field labels.
- **[src/settingsTab.ts](src/settingsTab.ts)** — Settings UI (`PluginSettingTab`). Strict positive-integer parsing (`parseStrictPositiveInt`) for numeric fields.
- **[src/settingsMigrate.ts](src/settingsMigrate.ts)** — `migrateSettings`, the versioned `MIGRATIONS` map, and `applyMigrations`. Returns a discriminated `MigrationResult` so the plugin can refuse to overwrite forward-version data.
- **[src/metadata.ts](src/metadata.ts)** — Single-file generation flow (`generateMetadata`, `generateMetadataForFile`), prompt building, and frontmatter write orchestration.
- **[src/bulkOrchestrator.ts](src/bulkOrchestrator.ts)** — Folder-level entry: confirm modal → progress modal → run → summary modal.
- **[src/bulkGenerate.ts](src/bulkGenerate.ts)** — Pure bulk-run engine: `collectCandidates`, `classifyCandidates`, `runBulk`, `computeDelayMs` (full jitter + Retry-After honoring).
- **[src/bulkConfirmModal.ts](src/bulkConfirmModal.ts)**, **[src/bulkProgressModal.ts](src/bulkProgressModal.ts)**, **[src/bulkSummaryModal.ts](src/bulkSummaryModal.ts)** — UI modals for the bulk run lifecycle. Confirm modal hard-caps `willChange` count with an explicit override checkbox.
- **[src/adapters/claude.ts](src/adapters/claude.ts)** — Anthropic SDK wrapper. Forces the `submit_metadata` tool, validates input, classifies errors into `ClaudeApiError` (`auth | rate_limit | overloaded | api | unknown`) with optional `retryAfterMs`. Only module allowed to import `@anthropic-ai/sdk` (enforced by Biome).
- **[src/adapters/frontmatter.ts](src/adapters/frontmatter.ts)** — `updateFrontMatter` adapter over `app.fileManager.processFrontMatter`.
- **[src/content/](src/content)** — Content extraction (`getContent.ts`), tokenization (`tokens.ts`), and truncation strategies (`truncate.ts`, `types.ts`).

### Tests

Tests are colocated with source files in `src/` (or alongside their adapter under `src/adapters/`):

- **Settings & migrations**: [settingsMigrate.test.ts](src/settingsMigrate.test.ts), [settingsTab.test.ts](src/settingsTab.test.ts).
- **Generation flow**: [metadata.test.ts](src/metadata.test.ts) (pure-helper format contracts: `parseTags`, `buildPrompt`), [generateMetadata.test.ts](src/generateMetadata.test.ts) (end-to-end integration through a fake `App`).
- **Adapter**: [callClaude.test.ts](src/callClaude.test.ts) (tool-use response, error taxonomy, Retry-After parsing), [adapters/frontmatter.test.ts](src/adapters/frontmatter.test.ts).
- **Bulk**: [bulkGenerate.test.ts](src/bulkGenerate.test.ts) (collect/classify/runBulk and `computeDelayMs`).
- **Content**: [content.test.ts](src/content.test.ts).
- **[src/test-preload.ts](src/test-preload.ts)** — Bun preload providing Obsidian API mocks.

### Scripts

- **[version-bump.ts](version-bump.ts)** — Syncs version from `package.json` into `manifest.json` and `versions.json`

### Data Flow

1. User runs "Generate metadata for current note" command
2. `generateMetadata()` checks which fields need population based on `updateMethod`
3. Content is extracted and optionally truncated via `getContent()`
4. `callClaudeForMetadata()` sends the prompt to the Anthropic API with a forced `submit_metadata` tool call
5. The model's `tool_use` block input is validated against the schema and returned as `MetadataFields`
6. `updateFrontMatter()` writes each field via `processFrontMatter()`

### Key Patterns

- **Frontmatter updates** use `app.fileManager.processFrontMatter()` — not `parseYaml`/`stringifyYaml`
- **Token counting** uses a regex that handles CJK characters, words, and punctuation: `/[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g`
- **Truncation methods**: `head_only` (first N tokens), `head_tail` (80% start + 20% end), `heading` (outline + first paragraph per section)
- **Anthropic client** is initialized with `dangerouslyAllowBrowser: true` since it runs inside Obsidian's Electron renderer
- **Tags, description, and title** all respect `updateMethod` — preserve_existing keeps populated fields, always_regenerate updates all
- **API calls** use a system message for instructions and wrap article content in `<article>` XML tags in the user message
- **Bulk retry policy**: rate-limit and overload errors retry on the schedule `[2s, 8s, 30s]` (`DEFAULT_RETRY_DELAYS_MS`). Each delay is jittered to `[0.5x, 1.5x]` to avoid synchronized retry storms across parallel clients. If the SDK error carries a `Retry-After` header, that value is honored, capped at 2x the scheduled base delay so a misbehaving header can't stall a long bulk run. The SDK also performs its own internal retries — the outer policy applies on top of that.
- **Settings schema migrations**: `MetadataToolSettings.schemaVersion` is stamped onto every saved file. Migrations live in the `MIGRATIONS` map in `src/settingsMigrate.ts`, keyed by the version they produce. To add a migration, append the next version key + mutator and bump `CURRENT_SCHEMA_VERSION` in `settings.ts` — `applyMigrations` throws if a target version is missing its entry, so the bump-without-migration bug is caught at plugin-load time. `migrateSettings` returns a discriminated `MigrationResult` (`kind: "ok" | "missing" | "future"`); when `kind === "future"`, the plugin loads defaults but sets `futureSchemaBlocked` and `saveSettings()` refuses to write, surfacing a Notice instead of clobbering forward-version data.
- **SDK boundary**: `@anthropic-ai/sdk` may only be imported from `src/adapters/claude.ts`. This is enforced by Biome's `noRestrictedImports` rule in `biome.json`; other modules consume the adapter's typed wrapper (`callClaudeForMetadata`, `ClaudeApiError`) so SDK types do not leak into application or domain code. Test files are excluded from the rule because they reference the SDK module name for mocking — both `mock.module("@anthropic-ai/sdk", ...)` setups and dynamic `import()` calls used to access mocked SDK error constructors.
- **Structured logging**: when `debugLogging` is on, the request path emits structured records via `src/logger.ts` (`logDebug`, `logError`) instead of prose. Every log line is `console.log("[Metadator]", { event, file, model?, requestId?, attempt?, durationMs?, errorKind?, errorMessage? })`. A short hex `requestId` (`newRequestId`, 8 chars from `crypto.randomUUID`) is minted per file inside `addMetadataWithClaude` so retries and write failures correlate to the API call that triggered them. Vocabulary: `claude_request_start` / `claude_request_completed` / `claude_request_failed` (per call), `claude_retry_scheduled` (bulk retry loop), `frontmatter_write_failed`, `generation_failed`.

## Build System

- **[build.ts](build.ts)** — Bun's native bundler producing CommonJS output (`main.js`)
- Externals: `obsidian`, `electron`
- Production builds are minified; dev builds are not
- `main.js` is committed to the repo (required by Obsidian plugin distribution)

## Release Process

1. Update `package.json` version
2. Run `bun run version` to sync manifest.json and versions.json
3. Run `bun run build` and commit the rebuilt `main.js` — Obsidian distributes the committed bundle
4. Open PR and merge to `main` before tagging (tags must point at the merged commit)
5. Tag `X.Y.Z` on the merged commit and push tags — GitHub Actions creates the release

Pre-release: run `bun run check` and `bun run build`.

## Code Style

Enforced by Biome: 2-space indent, organized imports, git-aware VCS integration.
