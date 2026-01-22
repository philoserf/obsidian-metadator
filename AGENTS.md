# Agents guidance

This file provides guidance to AI agents when working with code in this repository.

## Critical Rules

### Git Workflow

- **NEVER commit to main without explicit approval**
- Ask before committing anything
- Propose changes and wait for go-ahead before git operations
- Follow the git-workflow skill strictly
- Do not force push to main

## Project Overview

Metadator: An Obsidian plugin for automatically generating metadata (tags, descriptions, titles) for your notes using the Anthropic Claude API.

## Development Commands

### Setup

```bash
bun install
./setup-vault.sh  # Optional, test vault already configured
```

### Build and Development

```bash
bun run dev     # Watch mode with auto-rebuild
bun run build   # Production build (runs check first, minifies output)
```

### Code Quality

```bash
bun run check         # Run all checks (biome + markdownlint)
bun run typecheck     # TypeScript type checking only
bun run test          # Run unit tests
bun run lint:fix      # Auto-fix linting issues
bun run format        # Format code with Biome
```

### Validation and Release

```bash
bun run validate      # Full validation (types, checks, build)
bun run version       # Update manifest.json and versions.json from package.json version
```

## Architecture

### Key Files

- **[src/main.ts](src/main.ts)**: Plugin entry point, extends Obsidian's Plugin class
- **[src/metadata.ts](src/metadata.ts)**: Metadata generation orchestration
- **[src/responseParser.ts](src/responseParser.ts)**: Zod schema validation for Claude responses
- **[src/responseParser.test.ts](src/responseParser.test.ts)**: Comprehensive unit tests (13 tests)
- **[src/settings.ts](src/settings.ts)**: Type-safe settings interface
- **[src/settingsTab.ts](src/settingsTab.ts)**: Settings UI
- **[src/utils.ts](src/utils.ts)**: API calls, token counting, content truncation
- **[build.ts](build.ts)**: Bun bundler configuration

### Build System

- Bun's native bundler produces CommonJS output (`main.js`)
- Watch mode enabled in development with source maps
- Production build minified for distribution
- External dependencies: `obsidian`, `electron` (not bundled)

### Configuration Files

- **manifest.json**: Plugin metadata (id, name, version, minAppVersion: 1.0.0)
- **versions.json**: Maps versions to minimum Obsidian versions (auto-updated by version-bump.ts)
- **tsconfig.json**: ES2022 target, bundler module resolution, strict mode
- **biome.json**: Code formatter and linter (2-space indent, git integration)

## Release Process

1. Update `package.json` version
2. Run `bun run version` to sync manifest.json and versions.json
3. Commit: `git add . && git commit -m "chore: bump version to X.Y.Z"`
4. Tag: `git tag X.Y.Z`
5. Push: `git push origin main --follow-tags`
6. GitHub Actions automatically creates release with artifacts

Pre-release: Run `bun run validate` to check manifest, types, linting, and build.

## Core Functionality

### Metadata Generation Flow

1. User opens a note in Obsidian
2. User runs "Generate metadata for current note" command
3. Plugin extracts note content
4. Plugin calls Claude API via Anthropic SDK
5. Claude generates metadata (tags, description, title)
6. Plugin updates note's frontmatter
7. Plugin displays success notification

### Claude API Integration

**Files:** [src/metadata.ts](src/metadata.ts), [src/responseParser.ts](src/responseParser.ts)

- Initializes Anthropic client with user's API key
- Builds custom prompts based on user settings
- Sends truncated note content to Claude
- Parses and validates Claude's JSON response using Zod schema
- Handles errors gracefully with helpful, user-friendly messages
- Schema validation rejects unexpected fields and wrong types

**Supported Models:**

- `claude-sonnet-4-5-20250929` - Balanced (recommended, default)
- `claude-opus-4-5-20251101` - Most capable
- `claude-haiku-4-5-20251001` - Fastest, cheapest

### Content Truncation

**File:** [src/utils.ts](src/utils.ts)

Methods to reduce API costs:

- **head_only**: First N tokens only
- **head_tail**: Start (80%) + end (20%), omit middle
- **heading**: Document outline + first paragraph per section

Token counting supports Unicode, Chinese characters, and word-based counting.

## Settings System

**File:** [src/settings.ts](src/settings.ts)

Type-safe settings with defaults:

```typescript
interface MetadataToolSettings {
  apiKey: string;
  model: string;
  updateMethod: "always_regenerate" | "preserve_existing";
  truncateContent: boolean;
  maxTokens: number;
  truncateMethod: "head_only" | "head_tail" | "heading";
  tagsField: string;
  descriptionField: string;
  titleField: string;
  // ... custom fields and prompts
}
```

**UI:** [src/settingsTab.ts](src/settingsTab.ts) implements `PluginSettingTab` with password-masked API key, model dropdown, toggles, and sliders.

## Code Style

Enforced by Biome:

- 2-space indent
- No unused imports (auto-organized by type vs value)
- Type annotations required
- Template literals preferred
- No unused variables/parameters

Auto-fix: `bun run format` or `bun run lint:fix`

## Best Practices

1. **Always validate user input** before sending to Claude API
2. **Handle network errors gracefully** with user-friendly messages
3. **Show progress notifications** for long-running operations
4. **Validate API key** before making requests
5. **Log errors with context** for debugging (console.error)
6. **Test with sample notes** before committing changes
7. **Run `bun run validate`** before committing

### Error Handling Pattern

```typescript
try {
  const result = await callClaude(content, settings);
} catch (error) {
  if (error instanceof Error) {
    new Notice(`Failed to generate metadata: ${error.message}`);
    console.error("Metadata generation error:", error);
  }
  throw error;
}
```

### Working with Frontmatter

```typescript
import { parseYaml, stringifyYaml } from "obsidian";

const frontmatter = parseYaml(file.frontmatter);
frontmatter.tags = generatedTags;
frontmatter.description = generatedDescription;

app.vault.modify(file, stringifyYaml(frontmatter) + "\n---\n" + content);
```

## Test Vault

Project root is configured as an Obsidian vault. Sample notes in [Sample Note 1.md](Sample%20Note%201.md), [Sample Note 2.md](Sample%20Note%202.md), [Sample Note 3.md](Sample%20Note%203.md). Plugin symlinked from `.obsidian/plugins/metadator/`. Changes rebuild in watch mode; reload Obsidian (Cmd/Ctrl + R) to see changes.
