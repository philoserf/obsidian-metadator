# Changelog

## 2.0.2

### Fixed

- `updateFrontMatter` silently ignoring `append` when value was not an array; narrowed types so the combination is unrepresentable (#103)
- `truncateHeading` body section using a meaningless offset into the token stream, causing body to duplicate or skip source content; now tracks the consumed source position explicitly and omits the body when it renders empty (#102)
- `hasChanges` false-positive when every tag returned by Claude was already present; `updateFrontMatter` now returns whether the frontmatter was actually mutated and the success notice fires only on real changes (#100)

### Internal

- `@anthropic-ai/sdk` 0.89.0 → 0.90.0
- `softprops/action-gh-release` v2 → v3

## 2.0.1

### Changed

- Extract `MAX_RESPONSE_TOKENS` constant; move Anthropic error-notice mapping out of `callClaude` and into the orchestration layer
- Normalize `(app, file, ...)` parameter order across `updateFrontMatter` and `addMetadataWithClaude`
- Collapse duplicated tags/description/title update blocks into a single apply loop
- Replace hardcoded deploy path with `$OBSIDIAN_METADATOR_DEST` env var

### Removed

- Pre-2.0 settings migrations (`force`, `update_all`, `no-llm`, `empty_only`, `maxTokens`); sonnet/opus model renames retained
- `claude-code-review` workflow

### Added

- `THEORY.md`

### Internal

- Dependency updates: `@anthropic-ai/sdk` 0.82.0 → 0.89.0, `@biomejs/biome` → 2.4.12, `@types/bun` → 1.3.12, `@types/node` → 25.6.0

## 2.0.0

### Breaking Changes

- Rename `maxTokens` setting to `contentTokenLimit`
- Refactor API call signatures (system message + XML delimiters)

### Added

- Privacy notice about content sent to Anthropic API
- Debug logging toggle for prompt and response inspection
- Integration tests, callClaude error handling tests, settingsTab validation tests

### Fixed

- Respect `updateMethod` for tags instead of always appending
- Resolve `truncateHeading` body duplicating outline content
- Revert `isDesktopOnly` to false
- Implement actual file watching in build script
- Include test files in type checking
- Add types to tsconfig for TypeScript 6 compatibility

### Changed

- Use system message and XML delimiters in API call
- Extract `writeField` helper from repeated try/catch blocks
- Simplify API key check and `contentStr` variable

### Internal

- Update CLAUDE.md, document token regex rationale
- CI workflows, dependency updates

## 1.2.0

### Features

- Add Claude 4.6 models (Sonnet, Opus) and update default model
- Add unit tests for all pure functions (94 tests)
- Add Claude Code automations (auto-test hook, /release and /deploy-test skills)

### Fixes

- Replace greedy JSON regex with multi-match strategy for reliable response parsing
- Fix truncateHeadTail edge cases (slice(-0), early-return when limit >= length)
- Fix joinTokens spurious space after newline
- Resolve race condition and parsing bugs in metadata generation
- Harden parseMetadataResponse with null-safety and code-fence stripping
- Fix error handling flow (callClaude re-throws, addMetadataWithClaude catches)
- Guard ellipsis in all truncation functions

### Refactoring

- Extract pure functions for testability
- Simplify resolveUpdateMethod to delegate to isEmptyValue
- Clarify update method with intent-based naming (always_regenerate / preserve_existing)
- Simplify keep-method guard in updateFrontMatter

### Chores

- Converge repo structure, CI, and build config to canonical pattern
- Update dependencies (@biomejs/biome, @types/node, obsidian, typescript)
- Update LICENSE to MIT with current copyright
- Standardize tsconfig to ESNext
- Add CHANGELOG.md, deploy script, validation improvements

## 1.1.0

### Refactoring

- Remove custom metadata and extract tags functionality
- Simplify to core metadata generation workflow

## 1.0.0

Initial release. Automatically generate metadata for Obsidian notes using AI.
