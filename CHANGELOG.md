# Changelog

## 2.2.0

### Added

- Hard cap on bulk-run files-that-will-change with an explicit override checkbox in the confirm modal, so a misconfigured `updateMethod` cannot silently rewrite hundreds of notes (#114).
- Structured debug logging with per-file correlation IDs. When `debugLogging` is on, the request path emits JSON records (`event` + context) instead of prose, and a fresh `requestId` is minted per `addMetadataWithClaude` invocation so retry attempts and write-failure logs correlate to the API call that produced them (#120).
- Versioned settings-schema framework: every saved data file now carries `schemaVersion`, and migrations live in an ordered `MIGRATIONS` map keyed by the version they produce. Loading a future-version data file no longer clobbers it — the plugin loads defaults, surfaces a Notice, and refuses to save until the user resolves the mismatch (#121).

### Fixed

- Bulk retry delays are now jittered to `[0.5x, 1.5x]` of the base schedule and honor the SDK's `Retry-After` header (capped at 2x the scheduled base) so synchronized retry storms across parallel clients are avoided and a misbehaving header can't stall a long bulk run (#122).
- Token regex now matches non-Latin, non-CJK scripts (Cyrillic, Arabic, Devanagari, etc.) instead of dropping them from the count, fixing truncation budgets for those notes (#119).
- Prompt-side validation runs before the API call, and tool-use input parse failures surface as a clear error instead of a silent skip (#123).
- Loaded settings are validated at the trust boundary; malformed values fall back to defaults instead of poisoning later runs (#115).
- In-flight metadata generation aborts when the plugin unloads, with cancellation semantics refined so a Cancel that lands between progress and the API call skips cleanly (#113).
- Explicit timeout and request options on every Claude API call so a hung connection cannot block the command indefinitely (#110).

### Internal

- `@anthropic-ai/sdk` boundary is now enforced by a Biome `noRestrictedImports` rule — only `src/adapters/claude.ts` may import the SDK; other modules consume the typed wrapper (`callClaudeForMetadata`, `ClaudeApiError`) (#141).
- Refactors: structured tool-use response and adapter error taxonomy (#112, #118), `addMetadataWithClaude` boolean-flag parameters replaced with an options object (#117), `bulkModals.ts` split into per-modal files (#124), `utils.ts` split into focused modules (#111), `migrateSettings` extracted into `src/settingsMigrate.ts` (#139), settings options deduplicated and validation types tightened, per-helper test duplication trimmed in `metadata.test.ts` (#140).
- Risks of `dangerouslyAllowBrowser` documented in the Anthropic client adapter.
- Dependency bumps: `@anthropic-ai/sdk` 0.90.0 → 0.91.1, `@biomejs/biome` 2.4.12 → 2.4.13, `@types/bun` 1.3.12 → 1.3.13, `typescript` 6.0.2 → 6.0.3.

## 2.1.0

### Added

- Bulk metadata generation via right-click on a folder in the file explorer. Runs the existing per-note generator sequentially over every `.md` descendant, with a confirmation modal showing pre-run counts, an in-run progress modal with Cancel, and a summary modal listing changed / skipped / errored / remaining counts plus per-file error details. Warns when the batch exceeds 100 notes; no hard cap.
- Retry-with-backoff (2s / 8s / 30s) on `RateLimitError` and `InternalServerError` during bulk runs. Cancel is responsive during backoff — the sleep polls the abort flag every 100ms.

### Internal

- Extracted `generateMetadataForFile` worker from `generateMetadata`; the single-note command now wraps the worker. Behavior-preserving for single-note runs.
- `shouldGenerate` helper exported for pre-run classification without API calls (used by the bulk confirm modal).
- `runBulk` / `runFileWithRetry` guard `shouldAbort` at the top of every attempt, so a Cancel that lands between `onProgress` and the API call skips the file instead of burning a call.

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
