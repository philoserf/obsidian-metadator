# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude, parses the JSON response, and writes the results into the note's YAML frontmatter.

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

- **[src/main.ts](src/main.ts)** — Plugin entry point. Registers the `generate-metadata` command, loads/saves settings, migrates legacy `updateMethod` values.
- **[src/metadata.ts](src/metadata.ts)** — Orchestrates metadata generation. Checks whether fields need updating, builds the prompt dynamically (omitting title when disabled), calls Claude, parses JSON from the response with regex (`/{[\s\S]*}/`), and writes tags/description/title to frontmatter.
- **[src/settings.ts](src/settings.ts)** — `MetadataToolSettings` interface and `DEFAULT_SETTINGS`. Field names: `anthropicApiKey`, `anthropicModel`, `tagsFieldName`, `descriptionFieldName`, `titleFieldName`, `enableTitle`, `debugLogging`, `truncateContent`, `contentTokenLimit`, `truncateMethod`, `updateMethod`, plus per-field prompt strings.
- **[src/settingsTab.ts](src/settingsTab.ts)** — Settings UI (`PluginSettingTab`). Password-masked API key, model dropdown, toggles, and text inputs for field names and prompts.
- **[src/utils.ts](src/utils.ts)** — `callClaude()` (Anthropic SDK call with `dangerouslyAllowBrowser: true`), `getContent()` (content extraction and truncation), `updateFrontMatter()` (async writes via `app.fileManager.processFrontMatter()`).

### Tests

Tests are colocated with source files in `src/`:

- **[src/main.test.ts](src/main.test.ts)** — Plugin lifecycle and settings migration tests
- **[src/metadata.test.ts](src/metadata.test.ts)** — Metadata generation and parsing tests
- **[src/utils.test.ts](src/utils.test.ts)** — Utility function tests (truncation, Claude calls, frontmatter)
- **[src/callClaude.test.ts](src/callClaude.test.ts)** — Claude API call error handling tests
- **[src/settingsTab.test.ts](src/settingsTab.test.ts)** — Settings validation logic tests
- **[src/generateMetadata.test.ts](src/generateMetadata.test.ts)** — Integration tests for full metadata generation flow
- **[src/test-preload.ts](src/test-preload.ts)** — Test mocks for Obsidian API

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
