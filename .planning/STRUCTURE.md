# Project Structure

## Directory Layout

```text
obsidian-metadator/
├── .github/                    # GitHub Actions workflows
├── .obsidian/                  # Obsidian vault config (test vault)
│   └── plugins/metadator/      # Plugin symlink (dev)
├── scripts/                    # Build and utility scripts
│   └── validate-plugin.ts      # Plugin validation before release
├── src/                        # Source code
│   ├── main.ts                 # Plugin entry point
│   ├── metadata.ts             # Metadata generation logic
│   ├── settings.ts             # Settings interface (types + defaults)
│   ├── settingsTab.ts          # Settings UI
│   └── utils.ts                # Utilities (Claude API, content mgmt, frontmatter)
├── .planning/                  # Codebase documentation
│   ├── STACK.md                # Technology stack
│   ├── ARCHITECTURE.md         # System design
│   ├── STRUCTURE.md            # This file
│   ├── CONVENTIONS.md          # Code style and patterns
│   ├── TESTING.md              # Test structure (if applicable)
│   └── CONCERNS.md             # Known issues and improvements
├── build.ts                    # Bun build configuration
├── version-bump.ts             # Version update automation
├── main.js                     # Compiled plugin (CommonJS)
├── manifest.json               # Plugin metadata
├── versions.json               # Version-to-minAppVersion mapping
├── package.json                # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── biome.json                  # Code formatting/linting rules
├── AGENTS.md                   # Development guidance for AI agents
├── CLAUDE.md                   # Claude-specific instructions
├── DEVELOPMENT.md              # Developer setup guide
├── GETTING_STARTED.md          # Quick start documentation
├── README.md                   # Project overview
├── LICENSE                     # MIT license
├── Sample Note 1.md            # Test note examples
├── Sample Note 2.md            # (for testing in vault)
├── Sample Note 3.md            #
└── setup-vault.sh              # Vault initialization script
```

## Source File Organization

### src/main.ts (30 lines)

Plugin entry point extending Obsidian's Plugin class.

- `MetadataToolPlugin` class definition
- `onload()`: Initialize plugin, register command
- `loadSettings()`: Load from Obsidian storage
- `saveSettings()`: Persist to Obsidian storage

### src/metadata.ts (219 lines)

Metadata generation orchestration.

- `generateMetadata()`: Main entry point (validation, decision logic)
- `addMetadataWithClaude()`: Claude API call and response handling
- `MetadataResponse` interface (tags, description, title)
- Frontmatter update logic (append, update, keep)
- Error handling with user notifications

### src/settings.ts (56 lines)

Type-safe settings definition.

- `MetadataToolSettings` interface
  - API credentials (key, model)
  - Field names (3 fields)
  - Feature toggles (enableTitle, truncateContent)
  - Truncation options (method, maxTokens)
  - Update behavior (force vs. no-llm)
  - Prompt templates (3 templates)
  - Custom metadata array
- `DEFAULT_SETTINGS` constant with sensible defaults

### src/settingsTab.ts (306 lines)

Settings UI implementation.

- `MetadataToolSettingTab` extends PluginSettingTab
- Sections:
  - Anthropic API (key, model)
  - Update Settings (method, truncation)
  - Tags Settings (field name, list, prompt, extract button)
  - Description Settings (field name, prompt)
  - Title Settings (toggle, field name, prompt)
  - Custom Metadata (add field, delete field)
- Dynamic UI updates based on settings
- Tag extraction from vault

### src/utils.ts (237 lines)

Shared utilities.

- `callClaude()`: API integration
  - Anthropic client initialization
  - Message creation and error handling
  - User notifications for API errors
- `getContent()`: Content extraction and truncation
  - File reading (vault or editor)
  - Token-based truncation
  - Unicode/Chinese character support
  - Three truncation methods (head_only, head_tail, heading)
- `updateFrontMatter()`: YAML frontmatter updates
  - Three update methods (append, update, keep)
  - Type conversion for booleans
  - Array deduplication for tags
- `loadTags()`: Tag extraction from vault
  - Iterate all markdown files
  - Build frequency map
- `formatDate()`: Date formatting utility
  - Pattern-based replacement (YYYY, MM, DD, etc.)

## Key Patterns

### Settings Pattern

- Interface definition in `settings.ts`
- Type-safe defaults in same file
- Settings loaded/saved via Obsidian plugin API
- Settings tab creates reactive UI with onChange callbacks

### Error Handling Pattern

- Try-catch blocks in API calls
- User-friendly messages via Notice()
- Detailed console.error() for debugging
- Graceful exit without crashing

### Content Processing Pattern

- Token-based splitting for Unicode support
- Regex pattern matching for Chinese characters
- Multiple truncation strategies
- Preserve structure (headings, paragraphs)

### Frontmatter Update Pattern

- processFrontMatter() callback-based API
- Immutable updates within callback
- Three merge strategies for different use cases
- Array uniqueness for tags

## Build Artifacts

### main.js

- Compiled plugin output
- CommonJS format
- Minified in production
- Loaded by Obsidian when plugin enabled

### manifest.json

- Plugin ID: "metadator"
- Minimum Obsidian: 1.0.0
- Auto-updated by version-bump.ts

### versions.json

- Maps version strings to minimum Obsidian versions
- Auto-updated during release

## Testing Environment

The project root is configured as an Obsidian vault:

- Sample notes in root (Sample Note 1-3.md)
- Plugin symlinked from `.obsidian/plugins/metadator/`
- Changes rebuild in watch mode
- Reload with Cmd/Ctrl + R in Obsidian to test

## Script Files

### scripts/validate-plugin.ts

Pre-release validation:

- Check manifest.json format
- Verify versions.json consistency
- Validate TypeScript compilation
- Check code quality (Biome)
- Verify build succeeds

### version-bump.ts

Version management:

- Read version from package.json
- Update manifest.json
- Update versions.json
- Sync all three files

### setup-vault.sh

Optional vault initialization for local testing.

## Dependencies Summary

**Runtime** (1 package):

- @anthropic-ai/sdk: ~35 MB
  - Only dependency in production

**Dev** (7 packages):

- obsidian: ~500 MB (types + stub)
- typescript: ~200 MB
- @biomejs/biome: ~100 MB
- markdownlint-cli: ~50 MB
- Others: types, helpers

Total node_modules: ~800-900 MB

## File Sizes

- src/ directory: ~850 lines total
- main.js (compiled): ~15-20 KB (minified)
- manifest.json: <1 KB
- Configuration files: ~5-10 KB total
