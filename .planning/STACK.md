# Technology Stack

## Language & Runtime

- **Language**: TypeScript 5.9.3
- **Target**: ES2022
- **Module System**: ESNext (CommonJS output via Bun's bundler)
- **Runtime**: Bun (build/task runner)

## Build & Bundling

- **Bundler**: Bun's native bundler
- **Output Format**: CommonJS (main.js)
- **Watch Mode**: Enabled in development with source maps
- **Minification**: Production builds only
- **External Dependencies**: obsidian, electron (not bundled)

## Frameworks & Libraries

- **Obsidian API**: 1.11.4
  - Plugin base class
  - Metadata cache, vault operations
  - UI components (Settings, Notices)
  - Command registration
- **Anthropic SDK**: 0.71.2
  - Claude API client
  - Message creation and streaming
  - Error handling utilities

## Development Tools

- **Code Quality**:
  - Biome 2.3.11 (formatter, linter, import organizer)
  - ESLint integration via Biome
  - 2-space indent standard
- **Markdown Linting**: markdownlint-cli 0.47.0
- **Type Checking**: TypeScript compiler (strict mode)
- **Node Types**: @types/node 25.0.9

## Configuration Files

- **tsconfig.json**: Strict mode, bundler module resolution, ES2022 target
- **biome.json**: 2-space indent, git integration, import organization
- **.markdownlint.jsonc**: Markdown style rules
- **manifest.json**: Plugin metadata (minAppVersion: 1.0.0)
- **versions.json**: Version mapping for Obsidian compatibility

## Package Manager

- Bun for dependency management and task execution
- Lock file: bun.lock (binary format)

## Supported Models

- claude-sonnet-4-5-20250929 (default, recommended)
- claude-opus-4-5-20251101 (most capable)
- claude-haiku-4-5-20251001 (fastest, cheapest)
