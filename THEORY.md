# A theory of Metadator

For whoever picks this up next. `WALKTHROUGH.md` is the tour; `CLAUDE.md` is the operating
manual. This is neither. It is the set of ideas you have to be holding before you change
anything here, because most of what looks like excess in this codebase is load-bearing and
the load is not visible from the code alone.

## The world this models

An Obsidian note is two documents in one file: a YAML frontmatter block of assertions
_about_ the note, and the prose those assertions describe. Metadator derives the first from
the second by asking Claude for three things — a tag list, a description, and optionally a
title.

Stated that way it is a pure function, and if it were one, four fifths of this repository
would not exist. It is not, and the reason is a single fact that every mechanism here
answers to:

**The note is a live document and the request takes up to a minute.**

`REQUEST_TIMEOUT_MS` is sixty seconds (`adapters/claude.ts:12`). Across that minute the
user still has the vault. They can type into the very field the plugin is about to fill,
delete one, rename the file out from under the `TFile`, or fire the command a second time.
The recursive folder run multiplies the exposure by the size of a folder tree and then
leaves the vault unattended for the duration.

So the domain entity is not "a note" but **a decision made about a note at time T, applied
at time T+60s**. Nearly every guard in this system exists because that decision can go stale
in a specific way, and each guard is aimed at one specific way.

## The gap, and the four guards across it

Four mechanisms sit on the same window. They are not redundant; each closes a different
crack, and collapsing any of them into the others reopens a bug the project has already
paid for.

**`update_if_empty` re-reads inside the write.** `adapters/frontmatter.ts:39-49` re-checks
emptiness against the frontmatter Obsidian hands the `processFrontMatter` callback, not
against the caller's snapshot. That is the difference between "this field was empty when we
decided" and "this field is empty now that we are writing", and the second is the only one
that is safe under `preserve_existing`. Simplifying this back to a plain `update` restores
the bug where a description the user typed during the call is silently overwritten.

**`isEmptyValue` is one function so two clocks cannot disagree.** `emptyValue.ts` looks
like a module that should not exist until you notice it has exactly two callers a minute
apart: `shouldGenerate`, deciding whether to ask, and the `update_if_empty` re-check,
deciding whether to write. If those two predicates ever diverge, a field is judged empty on
the way out and empty again on the way back and gets overwritten — which is precisely the
outcome the re-check exists to prevent. The comment there is worth reading in full: it is
also why the predicate is deliberately _not_ a falsiness test, because `title: 0` is a
title.

**The in-flight set is where the two entry points meet.** `inFlight.ts` is a module-level
`Set<string>` and module-level is the point — the single-note command and the folder run are
separate call stacks that share nothing else, and the plugin is a singleton. Two overlapping
generations on one path mean two billed calls whose result is decided by write ordering
rather than by the user. The subtlety is `metadata.ts:158`: `lockPath` captures `file.path`
_before_ the call. Obsidian mutates `TFile.path` in place on rename, so releasing
`file.path` after a minute could free some other note's lock and leak the original for the
rest of the session.

**The delimiter is per-request.** `prompt.ts:37` wraps note content in `<article-{requestId}>`
rather than `<article>`. Note bodies are interpolated verbatim, and a note containing
`</article>` closed the wrapper early and had its remainder read as instructions. Escaping
would not have worked — the model is reading prose, not parsing XML, so `< /article>` stays
available — but a tag the note cannot guess closes the whole class of attempt. This is the
only mechanism here aimed at content the user did not write, and it matters because notes
are routinely clipped from the web and folder runs process them unattended.

If you remember one sentence from this document: **the snapshot is not the truth, and every
place that treats it as the truth is a bug this project has already had.**

## What decides, and what merely reports

There is a second organizing idea, less obvious than the first, and it explains the file
layout better than the directory names do.

Two questions look identical and are not:

- _Will this note change?_ — answered from `app.metadataCache`, cheaply, over a whole tree,
  to plan a run and populate a confirm dialog.
- _Should this field be written?_ — answered at write time from the live frontmatter, per
  field, per note.

`shouldGenerate` (`metadata.ts:91`) answers the first. `classifyCandidates`
(`bulkGenerate.ts:40`) answers it in bulk. `update_if_empty` answers the second. They use
the same `isEmptyValue`, but they are on opposite sides of the sixty-second gap, and a
maintainer who conflates them will "fix" an inconsistency that is deliberate.

The consequence to hold: **the plan is advisory and the write is authoritative.** A folder
run's confirm modal promises a count computed from the cache before the first request. By
the time file 400 is reached, the promise may be wrong. That is accepted, because the
per-field re-check catches the case where being wrong would destroy something. If you find
yourself wanting to re-plan mid-run, understand first that the plan's inaccuracy is not the
dangerous kind.

The same split explains the module boundary that CLAUDE.md calls the "bulk split":
`bulkGenerate.ts` decides and has no modal imports; `bulkOrchestrator.ts` reports and owns
every piece of UI. That boundary is principled, and it is the one to preserve when adding
anything to the bulk path. (It is also not quite complete — see the `maxBulkFiles` finding
below.)

## Failure is a policy, not an accident

The retry and halt machinery in `bulkGenerate.ts` reads like generic resilience boilerplate.
It is not; every constant encodes a claim about what a particular failure _means_.

The governing distinction is **did the server hear us**. A rate limit or an overload means
it heard and refused, so waiting is meaningful and later notes may still succeed. A
connection failure means we never arrived, and worse, each attempt burns the full sixty
seconds three times over because the SDK retries beneath us (`SDK_MAX_RETRIES = 2`, so
`REQUESTS_PER_ATTEMPT = 3`). Patience is therefore an order of magnitude more expensive for
a connection failure than for a throttle, which is the entire reason connection errors get
their own shorter schedule (`CONNECTION_MAX_RETRIES = 2`) and their own shorter halt streak
(`CONNECTION_HALT_STREAK = 2`) rather than the general `CONSECUTIVE_FAILURE_LIMIT = 5`. The
full policy once spent about an hour proving a dead network was dead.

The second distinction is **per-file or systemic**. A bad note fails once; a revoked key
fails every note identically. `auth` halts on the first occurrence because one round trip is
all the evidence a rejected key can produce. Everything else needs a streak, because one
`api` error is as likely to be one strange note. `"other"` — the kind for failures that
never reached the API at all, such as a write against a read-only vault — sits in the same
systemic category for the same reason.

Note the ordering that makes the streak honest: `rate_limit` and `overloaded` count toward a
halt, but they only _reach_ the halt counter after `runFileWithRetry` has exhausted the
whole backoff schedule for that file. By then they are a demonstrated ceiling, not a blip.
If you ever move the retry loop and the halt counter relative to each other, that property
is what you are at risk of breaking.

One more thing is downstream of this policy and easy to break silently:
`worstCaseApiCalls` in the confirm modal imports `DEFAULT_RETRY_DELAYS_MS` and
`REQUESTS_PER_ATTEMPT` rather than hard-coding either, so the number shown to the user
cannot drift away from the policy that produces it. Keep it that way.

## Counting and reconstruction want opposite things

`content/tokens.ts` and `content/truncate.ts` share a subtle constraint that is invisible if
you read either alone.

The tokenizer approximates a BPE tokenizer's _count_: CJK, kana and hangul per character;
everything else as word runs; nine punctuation marks; newlines; and a trailing `\S`
catch-all that is the load-bearing part, since without it emoji and every markdown symbol
matched nothing and vanished from the count. Whitespace other than `\n` stays uncounted
deliberately, because real tokenizers absorb it into the following word.

But that same uncounted whitespace means **token text cannot be reassembled into source
text**. Rejoining token strings drops or re-spaces everything the regex treats individually.
So `Token` carries `{text, start, end}` and truncation rebuilds output with
`sliceTokens(source, run)` — slicing the original string, never joining. Counting wants
tokens; reconstruction wants offsets; the array carries both because they are the same
array. Any new truncation strategy must slice, and any change to the regex must preserve
offsets.

The v-flag/u-flag pair in `buildTokenRegex` is a second instance of a rule this codebase
follows generally: **two implementations of one predicate are held identical by a shared
test suite, or not written at all.** The u-flag fallback exists for older mobile WebViews
that lack set subtraction, it reaches the same answer by negative lookahead, and
`content.test.ts` runs both through the same cases. The negative lookahead is not cosmetic —
without it a word run walks straight through a script boundary and `hello你好world` counts
as one token.

## Where the outside world gets in

Four seams, and they are not equally principled.

**The Anthropic SDK** may only be imported from `src/adapters/claude.ts`, and this is
mechanically enforced by Biome's `noRestrictedImports` (`biome.json`), not merely by
convention — tests are excepted because they mock the module by name. Everything upstream
sees `callClaudeForMetadata` and `ClaudeApiError` with its six-value `kind`. That union is
the real interface: the notice text in `metadata.ts`, the retryable set, the halt
explanations in the summary modal and the halt-streak choice are all switches over it. Add a
kind and you have four call sites to visit, and the type system will find three of them.

**Obsidian's vault API.** Reads go through `cachedRead`, not `read`, because this is pure
extraction that never derives a write — frontmatter writes go through `processFrontMatter`,
which reads its own copy. Writes go through `processFrontMatter` and never through
`parseYaml`/`stringifyYaml`. And `processFrontMatter` serializes and writes back on _every_
call whether or not the callback mutated anything, which is why `metadata.ts:432` skips
populated fields before calling it rather than inside it: otherwise every skipped field cost
an mtime bump, a vault modify event and disk I/O, per file, across a whole run.

**The settings file as a trust boundary.** `data.json` is user-editable and version-skewed,
so `migrateSettings` treats everything in it as untrusted: numbered migrations keyed by the
version they _produce_, then field-by-field normalization with bounded parsers. Two
properties are worth naming. `applyMigrations` throws when `CURRENT_SCHEMA_VERSION` names a
version `MIGRATIONS` has no entry for — the bump-without-migration bug fails loudly at
plugin load rather than silently stamping a new version onto untransformed data. And a
_forward_ version is refused rather than migrated: the plugin loads defaults, sets
`futureSchemaBlocked`, and `saveSettings` then declines to write at all, so downgrading does
not destroy a newer install's configuration.

**The model's answer.** Structured tool use, not prose parsing. `submit_metadata` with a
schema, forced via `tool_choice` everywhere except the model families in
`AUTO_TOOL_CHOICE_FAMILIES`, which reject forced tool use with a 400 and get an instruction
plus a larger token budget instead. Two things about this seam repay attention: the
`max_tokens` check happens _before_ the content blocks are examined, because a truncated
tool call still parses and `validateMetadataInput` only asserts that fields are strings, not
that they are complete. And validation is not enough on its own — `metadata.ts` guards a
second time on the _parsed_ value, because `","` is a valid string that `parseTags` turns
into `[]`, and `"   "` is a valid string that is not a description. **Validate the shape at
the boundary, judge the value at the point of use.**

## What this is shaped to absorb, and what it is not

Cheap, because the design anticipated it:

- **A new model.** `anthropicModel` accepts any well-formed id (`isModelId`); the dropdown
  is a datalist of suggestions, not a constraint. A model released after this build works
  without a code change, and survives a reload. If a whole family rejects forced tool use,
  extend the `AUTO_TOOL_CHOICE_FAMILIES` prefix regex.
- **A new truncation strategy.** Add to the `TruncateMethod` union and the
  `VALID_TRUNCATE_METHOD_OPTIONS` list; the settings UI is generated from those constants.
  Slice, don't join.
- **A new error kind.** Extend `ClaudeErrorKind` and let the compiler walk you round.
- **A new settings field.** Add to the interface, `DEFAULT_SETTINGS`, and a bounded reader
  in `migrateSettings`. A field with no reader there silently vanishes on load.

Expensive, because it contradicts something structural:

- **Concurrency in the bulk run.** `runBulk` is a sequential `for` loop and the retry policy,
  the halt streak, the progress display and the confirm modal's call estimate all assume
  that. Parallelism is not a change to the loop; it is a change to the meaning of
  "consecutive".
- **Anything but frontmatter.** The whole write path is `processFrontMatter`, and the
  distinctness invariant on the three field names exists because they are keys in one YAML
  map. Inline tags or body edits are a different write model.
- **A second provider.** The `ClaudeErrorKind` union is Anthropic's failure taxonomy wearing
  a local name, and the tool-use contract is Anthropic's. `adapters/claude.ts` is where a
  provider seam _would_ go, but it is currently a wrapper, not an abstraction.
- **Field-level generation policy.** `shouldGenerate` is all-or-nothing per note: any empty
  field triggers a request that generates all three. Wanting "regenerate only the
  description" means splitting one decision that is currently one boolean.

The place a maintainer who has not read this document does damage is `metadata.ts`
lines 328-438. It looks like three near-identical field updates begging to be collapsed into
a loop over a config table. They are not identical: tags append and re-check nothing,
description and title update, and under `preserve_existing` the update path routes to
`update_if_empty` while the append path deliberately does not need to. The second-most
likely damage is "simplifying" `emptyValue.ts` into a falsiness check.

## Uncertainties

Marked because you should not trust these the way you can trust the rest.

**I am reading intent out of comments, and the comments may be better than the code.** This
codebase documents its own reasoning to an unusual degree — most non-obvious lines carry a
comment naming the failure they prevent and a GitHub issue number. That is a real asset and
`git log -S` on a constant name is unusually likely to answer a "why is this here"
question. But it also means my confidence about _intent_ is largely confidence in the
comments. Where a comment and the code disagree, I have filed the disagreement; where both
are silent, I am guessing.

**The auto-tool-choice path is unverified against the live API.** The tests assert request
shape only, and `output_config: { effort: "low" }` plus `tool_choice: "auto"` is the one
production path no test can prove works end to end. `bun run compare-models` is the tool for
checking it, and it costs money.

**`heading` truncation's `bodyStart` may drop more than intended.** `bodyStart` advances to
the token end of the last outline-contributing line anywhere in the document, so the `Body:`
section is whatever follows the _last_ captured paragraph, not the head of the document, and
prose in the middle of a well-headed note contributes nothing. I read this as intended for
an outline strategy — the whole point is to summarize structure — but I found no comment or
test establishing it as a decision rather than a consequence. It is the first thing I would
check if someone reports `heading` mode losing content.

**`main.ts` has no test at all.** Nothing in `src/` imports it except `settingsTab.ts`, for
a type. The plugin lifecycle, the folder-menu error handling and the forward-schema write
block are all uncovered, in a repository with 363 passing tests. I take this to be about
the difficulty of instantiating a `Plugin` under the `obsidian` types-only package rather
than a judgment that those paths do not matter, but I am inferring.

**`runBulkForFolder`'s `shouldAbort` option has no production caller.** `main.ts` passes
only `signal`. It appears in the public options type and in the abort computation, and only
tests supply it. I could not tell from the code whether it is a deliberate seam or a
leftover from before the `AbortController` wiring landed; `code-reduction` is the pass that
should decide.

## Findings filed

| #   | Severity | Issue                                                        | Primary location             |
| --- | -------- | ------------------------------------------------------------ | ---------------------------- |
| 1   | medium   | `readme-denies-the-folder-bulk-feature-it-ships`             | `README.md:14`               |
| 2   | medium   | `title-field-name-collision-resets-all-three-while-disabled` | `src/settingsMigrate.ts:246` |
| 3   | medium   | `max-bulk-files-cap-is-enforced-only-by-the-confirm-modal`   | `src/bulkConfirmModal.ts:71` |
| 4   | medium   | `forward-schema-write-block-is-untested`                     | `src/main.ts:102`            |
| 5   | low      | `readme-describes-json-parsing-not-tool-use`                 | `README.md:20`               |
| 6   | low      | `settings-comment-locates-migrations-in-main-ts`             | `src/settings.ts:24`         |

**Total: 6 issues (0 critical, 0 high, 4 medium, 2 low)**
