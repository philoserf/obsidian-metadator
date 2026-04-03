# Changelog

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
