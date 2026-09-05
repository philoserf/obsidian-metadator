# Changelog

## 2.5.0

Six milestones of code-audit work: 44 issues from the 2.4.0 audit, plus the default prompts and two issues found while reviewing the fixes.

### Added

- **Bulk runs now stop when the failure is systemic rather than per-file.** Previously every error was isolated, so an invalid or revoked API key on a 500-note folder run made ~500 doomed round-trips and produced ~500 near-identical summary rows before the user learned the key was bad — the first failure already proved the run could not succeed. A run now halts immediately on an authentication error, and after five consecutive failures of the same kind otherwise. The summary gains a third state, "Stopped early", distinct from both a completed run and a user cancellation, and names what to go and fix. (#172)
- **Network failures are retried instead of failing a note outright.** A connection drop or request timeout was classified alongside ordinary API errors and got no retry at all, so a momentary Wi-Fi blip permanently failed whatever note was in flight. Connection errors now retry on a shorter schedule than throttling does, and halt the run after two consecutive rather than five — a hung socket burns the full request timeout on each of the SDK's internal attempts, so patience is far more expensive for this kind of failure than for a rate limit. (#180, #221)
- **Frontmatter field names are checked for collisions**, at both the settings UI and on load. Setting two of the three to the same key silently destroyed data in the user's notes: tags was written as an array, then the description overwrote the same key with a string, and the run reported success. On load, a collision resets all three to their defaults. (#200)

### Changed

- **Default prompts for tags, description and title have been rewritten.** The old ones leaned on adjectives a model cannot check itself against ("concise but useful", "minimal adjectives"). Tags now ask for one note-kind tag from a fixed list plus topical tags, and state the two constraints the plugin depends on — no leading `#`, no comma inside a tag, since tags arrive as one comma-separated string. Titles specify sentence case and no surrounding quotation marks.

  **Existing users are unaffected.** Saved prompts are kept; the new defaults apply to new installs and to any field you clear.

- **YAML frontmatter no longer counts against the content token limit.** A note with many properties or a long existing tag list spent its whole budget on YAML before any prose was considered, and under the `heading` strategy that YAML was handed to the model inside a "Body:" section as though it were prose. (#164)

  **Behavior change:** more of your prose now fits under the same `contentTokenLimit`.

- **The large-batch warning counts differently, and higher.** It triggered on every scanned markdown file rather than on the files that will actually change, so a folder of 500 already-tagged notes with three to generate raised an alarm while 90 notes all needing generation raised none. The quoted call volume now includes retries — both the plugin's and the SDK's — so it states a real ceiling rather than the best case. Expect a number roughly 3× what the old copy showed for the same folder. (#169, #157)

- **Settings fields commit when you leave them, not on every keystroke.** Clearing a numeric field is the first keystroke of almost every edit, and an empty box is invalid — so changing 500 to 300 used to fire a warning and snap the old value back before you typed a digit. Text and prompt fields now debounce their save instead of writing the whole settings file on each character. (#203, #177)

### Fixed

- **`0` and `false` were treated as empty frontmatter values.** Under `preserve_existing` a note with `title: 0` was judged to need generation, sent to the API, and then had that value overwritten by the write-time re-check — the exact outcome that re-check exists to prevent. Silent loss of user data under the policy that promises not to touch populated fields. (#201)

  **Behavior change:** the bulk confirm dialog's "will change" count may drop for vaults containing such notes. That is the correction.

- **The `keep` write method wrote.** It filled the field whenever it was absent at write time — which, since `keep` is only chosen for a field that was populated when the decision was made, can only mean the user deleted it during the request. The plugin restored what they had just removed and counted the file as changed. Keeping a field also no longer opens the file at all, so it no longer bumps the note's modification time or fires a vault change event. (#202, #185)

- **Fenced code blocks were read as document structure.** Under the `heading` truncation strategy, a `#` comment inside a fenced code block was taken for a markdown heading, added to the outline, and flipped paragraph capture so the following line of code was captured as prose. (#166)

- **Soft-wrapped paragraphs were cut at their first line.** The `heading` strategy captured one physical line per section, so every continuation line of a paragraph was dropped from the outline even when the whole paragraph fitted under the cap. (#167)

- **Notes with no headings produced an empty `Outline:` wrapper** around their content instead of a plain truncation. (#168)

- **A model returning only punctuation for tags wrote an empty array** into frontmatter where none existed, and reported success for content that did not exist. (#161)

- **Titles that merely open and close with quoted phrases were mangled.** `"Hello" and "Goodbye"` lost its outer characters and ended up with unbalanced quotes. (#206)

- **Note content could close the prompt's `<article>` wrapper** and have everything after it read as instructions rather than as the article. The wrapper now carries a per-request tag the note cannot guess. The exposure was bounded — the only tool available is metadata submission — but notes are routinely clipped from the web or synced from shared vaults, and folder runs process them unattended. (#204)

- **A response truncated at the output token limit was accepted silently**, writing an incomplete description to frontmatter with no indication anything had been cut. (#174)

- **On older mobile WebViews the token counter merged across script boundaries.** The fallback regex consumed a Latin word run straight through into adjacent CJK characters — `hello你好world` counted as one token instead of four — silently undercounting any bilingual note. (#162)

- **The recursive folder action had no error handling.** Obsidian does not await that handler, so any unexpected failure was an unhandled promise: no notice, no log, and a menu item that appeared to do nothing when clicked. (#171)

- **Overlapping generation on one note is now prevented.** A double-triggered command, or the single-note command used on a file a folder run was already processing, made two separately billed API calls whose final result depended on which write landed last. (#173)

- **Each bulk run leaked an abort listener** onto a signal that lives for the whole plugin session, along with the closure holding that run's state. (#199)

- **The bulk summary's error list is grouped and capped.** It rendered one row per failed file with no limit, synchronously on the UI thread, so a systemic failure over a large batch meant thousands of near-identical DOM nodes and a visible stall. (#183)

- **Whitespace-only frontmatter field names were accepted** by the settings UI, appeared to stick, produced a malformed YAML key, and then reverted on the next plugin load. (#186)

- **`maxBulkFiles` and `contentTokenLimit` had no upper bound**, so an all-digit paste became a precision-lossy number that still passed validation — defeating the purpose of a setting whose entire job is to be a hard limit. The API key field was likewise unbounded and would persist an accidental paste of an entire file. (#184, #158)

### Internal

- One Anthropic client is now cached per API key rather than constructed per request and per retry, so a folder run keeps its connection pool instead of paying TLS setup for every note. (#207)
- Note content is read through the vault cache rather than from disk. (#205)
- The test suite is now type-checked. It had been excluded from `tsconfig.json`, which let three genuine typing errors reach a green CI during this work. (#223)
- Dead code removed: `content/types.ts`, the `metadata.ts` re-export layer, `splitIntoTokens`, `PresentationMode`, `WritePolicy` and its two mapping functions, the `updateFrontMatter` overloads, and a duplicated `isAbortError`. (#208–#215, #159, #160, #163, #210, #211)
- `walkthrough.md` regenerated for the current source, and a new `THEORY.md` records which mechanisms are load-bearing and why.

## 2.4.0

### Fixed

- Truncation silently deleted every character the token regex did not recognize. `TOKEN_REGEX` matched CJK, word runs, nine punctuation marks and `\n` and nothing else, so emoji and ordinary markdown syntax (`* _ ` [ ] ( ) - : | ...`) matched no alternative: they were absent from the token count, and because the truncation functions rebuilt their output by re-joining matched tokens rather than slicing the source, they were also dropped from the text sent to the API. `# Title\n\nThis is **bold** and _italic_ ...` truncated to `# Title\n\nThis is bold and...`. Tokens now carry source offsets and truncation slices the original string, and a `\S` catch-all makes every non-whitespace character count. (#179, #182)

  **Behavior change:** notes with heavy markdown or emoji now report a higher token count than before — a more accurate one. If you set `contentTokenLimit` by trial and error against the old undercount, less prose will fit under the same limit. Spaces and tabs are still uncounted, matching how real tokenizers absorb whitespace into the following word; `joinTokens` is gone, since nothing reconstructs text from token strings any more.
- A frontmatter write that threw was indistinguishable from "this note needed nothing": `writeField` returned `false` for both, so a file whose every write failed came back as `{kind: "skipped", reason: "no changes"}`. In bulk runs the per-field notice is suppressed, so the summary counted such a file as skipped even though the API had been called and billed; in the single-note flow `"skipped"` produces no final notice at all. Write failures are now tracked separately and reported as `kind: "error"`, naming the fields that failed and whether others were written. (#187)
- Under `preserve_existing`, a field the user typed into while a generation request was in flight could be silently overwritten by the model's output. The write decision was made from a `metadataCache` snapshot taken before the request, which can run for up to `REQUEST_TIMEOUT_MS`, and then applied unconditionally at write time. The emptiness check now happens inside `processFrontMatter`, against the live frontmatter, via a new `update_if_empty` adapter method. `always_regenerate` still overwrites, as intended. (#178)

## 2.3.1

### Added

- `bun run compare-models` dev script: sends the same note content to the live API once per configurable model and prints tags/description/title side by side for manual comparison.

### Fixed

- `src/metadata.ts` had a module-level `import { Notice } from "obsidian"`, but the `obsidian` package ships type declarations only — no runtime module exists outside Obsidian itself, so importing anything from `metadata.ts` (even the fully pure `buildPrompt`) crashed when run standalone via `bun run`. Extracted `buildPrompt`, `parseTags`, and `PromptParts` into a new Obsidian-free module, `src/prompt.ts`; `metadata.ts` re-exports them for backward compatibility.

### Internal

- Fixed a pre-existing lint warning (`useOptionalChain` in `src/adapters/claude.ts`) and migrated `biome.json`'s deprecated `linter.rules.recommended` field to `linter.rules.preset`.

## 2.3.0

### Changed

- Default and selectable Claude models updated to the current generation: `claude-sonnet-5`, `claude-opus-5`, and the undated `claude-haiku-4-5` alias, replacing the pinned Sonnet 4.6 / Opus 4.6 / dated Haiku 4.5 IDs. A new settings-schema migration (v1 → v2) rewrites existing users' stored model selection automatically.

### Internal

- Dependency bumps: `@anthropic-ai/sdk` 0.111.0 → 0.115.0, `@biomejs/biome` 2.5.4 → 2.5.7, `@types/node` 26.1.1 → 26.1.2. Also fixes `bun.lock` having drifted out of sync with `package.json`'s `^0.115.0` range for `@anthropic-ai/sdk` (still pinned at 0.111.0) since a prior dependency-bump PR never regenerated the lockfile.

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
