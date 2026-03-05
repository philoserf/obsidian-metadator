# Metadator

## Critical Rules

- **NEVER commit to main without explicit approval** — see global git rules for full workflow

## Project Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude, parses the JSON response, and writes the results into the note's YAML frontmatter.

## Development Commands

```bash
bun install                # Install dependencies
bun run dev                # Watch mode with auto-rebuild
bun run build              # Production build (runs check first, minifies)
bun run check              # TypeScript type-check + Biome lint/format
bun run typecheck          # TypeScript type checking only
bun run lint:fix           # Auto-fix linting issues
bun run format             # Format code with Biome
bun run format:check       # Check formatting without writing
bun run validate           # Full validation via scripts/validate-plugin.ts
bun run version            # Sync manifest.json and versions.json from package.json
bun run deploy             # Copy main.js + manifest.json to notes vault plugin dir
bun test                   # Run unit tests
```

## Architecture

### Source Files

- **[src/main.ts](src/main.ts)** — Plugin entry point. Registers the `generate-metadata` command, loads/saves settings, migrates legacy `updateMethod` values.
- **[src/metadata.ts](src/metadata.ts)** — Orchestrates metadata generation. Checks whether fields need updating, builds the prompt dynamically (omitting title when disabled), calls Claude, parses JSON from the response with regex (`/{[\s\S]*}/`), and writes tags/description/title to frontmatter.
- **[src/settings.ts](src/settings.ts)** — `MetadataToolSettings` interface and `DEFAULT_SETTINGS`. Field names: `anthropicApiKey`, `anthropicModel`, `tagsFieldName`, `descriptionFieldName`, `titleFieldName`, `enableTitle`, `truncateContent`, `maxTokens`, `truncateMethod`, `updateMethod`, plus per-field prompt strings.
- **[src/settingsTab.ts](src/settingsTab.ts)** — Settings UI (`PluginSettingTab`). Password-masked API key, model dropdown, toggles, and text inputs for field names and prompts.
- **[src/utils.ts](src/utils.ts)** — `callClaude()` (Anthropic SDK call with `dangerouslyAllowBrowser: true`), `getContent()` (content extraction and truncation), `updateFrontMatter()` (async writes via `app.fileManager.processFrontMatter()`).

### Tests

Tests are colocated with source files in `src/`:

- **[src/main.test.ts](src/main.test.ts)** — Plugin lifecycle tests
- **[src/metadata.test.ts](src/metadata.test.ts)** — Metadata generation and parsing tests
- **[src/utils.test.ts](src/utils.test.ts)** — Utility function tests (truncation, Claude calls, frontmatter)
- **[src/test-preload.ts](src/test-preload.ts)** — Test mocks for Obsidian API

### Scripts

- **[scripts/validate-plugin.ts](scripts/validate-plugin.ts)** — Full plugin validation (typecheck + lint + build)
- **[version-bump.ts](version-bump.ts)** — Syncs version from `package.json` into `manifest.json` and `versions.json`

### Data Flow

1. User runs "Generate metadata for current note" command
2. `generateMetadata()` checks which fields need population based on `updateMethod`
3. Content is extracted and optionally truncated via `getContent()`
4. `callClaude()` sends the prompt to the Anthropic API
5. Response JSON is extracted with regex and parsed
6. `updateFrontMatter()` writes each field via `processFrontMatter()`

### Key Patterns

- **Frontmatter updates** use `app.fileManager.processFrontMatter()` — not `parseYaml`/`stringifyYaml`
- **Token counting** uses a regex that handles CJK characters, words, and punctuation: `/[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g`
- **Truncation methods**: `head_only` (first N tokens), `head_tail` (80% start + 20% end), `heading` (outline + first paragraph per section)
- **Anthropic client** is initialized with `dangerouslyAllowBrowser: true` since it runs inside Obsidian's Electron renderer
- **Tags are appended** (deduped); description and title use update/keep logic based on `updateMethod`

## Build System

- **[build.ts](build.ts)** — Bun's native bundler producing CommonJS output (`main.js`)
- Externals: `obsidian`, `electron`
- Production builds are minified; dev builds are not
- `main.js` is committed to the repo (required by Obsidian plugin distribution)

## Test Vault

The project root is configured as an Obsidian vault. Sample notes: [Sample Note 1.md](Sample%20Note%201.md), [Sample Note 2.md](Sample%20Note%202.md), [Sample Note 3.md](Sample%20Note%203.md). The plugin is symlinked from `.obsidian/plugins/metadator/`. Changes rebuild in watch mode; reload Obsidian (Cmd+R) to pick them up.

## Release Process

1. Update `package.json` version
2. Run `bun run version` to sync manifest.json and versions.json
3. Commit and tag: `git commit -m "chore: bump version to X.Y.Z"` then `git tag X.Y.Z`
4. Push with tags — GitHub Actions creates the release

Pre-release: run `bun run validate`.

## Code Style

Enforced by Biome (`biome.json`): 2-space indent, organized imports, git-aware VCS integration. Run `bun run format` or `bun run lint:fix` to auto-fix.
