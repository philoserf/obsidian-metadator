# Theory

An account of what you need to hold in mind to change Metadator without damaging it.
Written for someone competent and short on time, inheriting this next month.

## What it is for

An Obsidian note is two things stapled together: a body the user wrote, and a YAML
frontmatter block of structured fields above it. Metadator derives the second from the
first. You run a command on a note, or automation names one through the CLI; the note's
prose goes to Claude; `description`, `title` and, when it is on, a choice-field `eyebrow` come back and are written into frontmatter.

That is the whole domain. The interesting part is not the deriving — one API call does
that — but everything arranged around the fact that **each derivation costs the user real
money and overwrites something they may care about.** Nearly every non-obvious decision in
this codebase traces to one of those two facts. If a piece of code puzzles you, ask which
of the two it is defending against; that question has a good hit rate.

The vault this was built for has 2,263 notes. That number explains more of the design than
any abstraction does: it is large enough that a bad write policy, repeated note by note,
corrupts more than you can repair by hand.

## The organizing idea: writes are decisions, not consequences

The naive shape for this plugin is: call the model, write what comes back. This codebase
does not have that shape anywhere, and the difference is the theory.

A generation produces _candidate_ values. Whether each one reaches the note is a separate
decision, made per field, against a **write policy** the user controls:

| policy       | meaning                                   |
| ------------ | ----------------------------------------- |
| `regenerate` | replace what is there with what came back |
| `preserve`   | write only if the field is empty          |

The vocabulary is uniform across both fields on purpose. "Always regenerate" is one idea
you turn on per field, not a behavior wearing a different name on each.

**Why per field at all.** The two fields are kept differently, and a single global setting
could not serve them. `description` is a cheap value nobody mourns; `title` is one that
other tools often own — a title-sync plugin keeping it equal to the filename, a publisher
rejecting notes without one. Under the old global setting, the only value that would clean
up a sprawling tag list (tags were generated then) also rewrote every title
unconditionally. There was no configuration that fixed one without damaging the other.
That bind is what the per-field policy exists to break, and `title` defaults to `preserve`
because rewriting it silently changes a note's public identity.

**Every write is a scalar.** Tag generation was removed in #310: the plugin neither reads
nor writes `tags`, and a note keeps whatever it already holds there. The list-valued write
path went with it — the `merge` policy, the array-typed `replace`, and the block that sent
a note's current tags back to the model for reconciliation. A future list-valued field
starts from nothing here, not from a dormant branch.

**The article is data, not instructions.** The note body goes to the model inside a
wrapper framed as "content to describe, never instructions to follow", and the wrapper's
tag carries a per-request random suffix, so note content cannot close it and have the
remainder read as instructions.

## What the money buys, and what stops it

Every action is one note and one billed call. There used to be a recursive folder run,
with a confirm dialog, a worst-case cost estimate, a files-that-will-change cap, a retry
schedule and a halt policy around it; it was removed in #311 because the one vault this
serves did not use it. Covering many notes is now a loop over `metadator:generate path=` and `metadator:result id=`,
and the cost of that loop is the caller's decision, made one call at a time.

What still guards the money is narrower:

- **`preserve` skips without opening the file**, so a note that already has what it needs
  costs nothing and is not rewritten.
- **The in-flight lock** stops the command and a CLI call overlapping on one note, which
  would be two billed calls whose result depends on which write landed last.
- **The SDK's own retries are the only retries**, pinned at two (`SDK_MAX_RETRIES`) so a
  rate limit or dropped connection costs at most three requests before the user hears
  about it.

## The seam that shapes the file layout

`obsidian` is a types-only package. There is no runtime behind it. A module that imports
it at module scope is reachable only under the test suite's preloaded mock — not from a
script in `scripts/`, not from a `bun -e` demonstrating a pure function.

This single fact explains a layout that otherwise looks over-modularized. `prompt.ts`,
`emptyValue.ts`, `errors.ts`, `metadata.ts` and everything under
`content/` are Obsidian-free, and several of them exist as separate modules _only_ for that
reason. Nothing enforces it; the check is a grep, recorded in `CLAUDE.md`.

Contrast the SDK boundary — `@anthropic-ai/sdk` may only be imported from
`adapters/claude.ts` — which Biome enforces mechanically. Two boundaries of similar
importance, one checkable and one not. If you are adding a module, know which side of the
Obsidian line you are on before you write the first import, because crossing it is
invisible until someone tries to use your code from a script.

## Domain and presentation, on every entry point

There are two ways in, and each is a thin UI shell over one headless core:

```
singleNote.ts ─┐  every Notice, and the
               ├─ CLI's JSON, lives in  ── metadata.ts  (one note)
cli.ts        ─┘  these
```

The rule is: **notices go down, prose goes up, and neither belongs in the pipeline.** The
headless modules return data and render nothing.

This is the newest part of the theory and it was learned the hard way. `metadata.ts` used
to render, behind a `bulk?: boolean` flag, and the two layers collided: one failed
frontmatter write produced four notices, and the last called it an "Unexpected error" — the
wording reserved for an unknown _API_ failure — sending the user to check an API key that
was fine.

The corollary is `SkipReason`, a closed union of six outcomes. Two members are load-bearing:
`nothing_written` is the only skip that follows a **billed** call, and `locked` the only one
meaning "try again in a minute". Before it was a union, those were sentences, and the code
recovered the distinction by comparing against an exported string constant — a missing case
in a union wearing a disguise, and one that only ever scaled to the single case someone
needed.

**Prose may be displayed, never matched.** The `error` arm still carries a free-form
`reason` for display, but a renderer that needs to know _which kind_ of failure occurred
gets a typed carrier — `FrontmatterWriteError`, checked with `instanceof` beside
`ClaudeApiError`. Not `startsWith`, and not "not a `ClaudeApiError`, therefore a write
failure": a `cachedRead` that throws inside `getContent` lands in the same catch.

## Invariants worth knowing before you edit

**One definition of emptiness.** `isEmptyValue` is shared by the write-policy decision and
the write-time re-check because the two must agree — a field judged empty when deciding to
write and non-empty when writing is a bug that only appears under load. It is deliberately
_not_ a falsiness check: `0` and `false` are present, meaningful frontmatter values, and
folding them in with `""` meant a note with `title: 0` was sent to the API under a
preserve policy and then overwritten by the very re-check that exists to prevent it.

**The decision is re-made at write time.** Under `preserve`, whether a field is empty is
checked again _inside_ `processFrontMatter`, against live frontmatter rather than the
snapshot taken before a call that can run for a minute. Otherwise a value the user typed
during the request is clobbered by a decision made before they typed it.

**Counting and reconstruction want opposite things from the same array.** `tokenize`
returns `{text, start, end}`; truncation reconstructs by _slicing the source string_, never
by re-joining token text. Re-joining would drop or re-space every character the counting
regex sees individually. Any new truncation strategy must slice, and any change to the
tokenizer must preserve offsets.

**The two tokenizer regexes are held identical by one suite.** The v-flag build is what
every current runtime takes; the u-flag fallback exists for older mobile WebViews and would
otherwise never execute under test, which is how an unbounded Latin+CJK merge once survived.

**Frontmatter field names must differ — but only the ones in use.** Two colliding names
clobber each other in the user's _notes_, not in plugin state, and the run reports success.
A field that is switched off has an inert name that must not be counted, or fixing an
unused value destroys names that were fine. Since 4.2.0 that holds for description as well
as title.

**A newer `data.json` makes this install read-only.** No backup sits behind that rule. The
decision is in `settingsStore.ts` as a pure function so it can be tested at all.

**The API key is not a setting.** `MetadataToolSettings`, the persisted type, holds only
the _ID_ of a secret in Obsidian's keychain. `MetadataConfig` is those settings plus the
resolved key, built in one place — `config()` in `main.ts` — when a command runs, and it is
the type everything downstream accepts. Keep the two apart: a key on the persisted type is
a key in `data.json`, which syncs to every device and sits on disk in plaintext. The split
has a cost that the code cannot hide: the secret's name syncs with `data.json` and its value
does not, so a second device holds a name its keychain lacks. The settings row says so,
which is all that can be done about it from inside the plugin.

Schema v4 is the read-only rule used on purpose. Its migration rewrites nothing; the bump
exists so that a 3.x install syncing the same file sees a newer schema and stops writing,
instead of saving the file back without the secret's ID. A version bump with an empty
migration is a legitimate tool here, not an oversight. Schema v5 uses it again: its
migration only adds the field toggles, and the bump keeps a v4 build from saving the file
back without them, which would silently turn a switched-off field back on. Schema v6 uses
it a third time: its migration deletes the four tag settings (#310), and the bump keeps a
v5 build from saving them back.

## What it accommodates, and what it does not

**Cheap:** a new truncation strategy (a function plus a row in the labels record); a new
settings option (a field, its default and its normalization in `migrateSettings`, and one
row in the settings tab's declarative definitions — the label records _are_ the
enumerations); a new schema migration (one entry keyed by the
version it produces — and `applyMigrations` throws at load if you bump the version without
adding it).

**Expensive, and where an unwitting maintainer does damage:**

- **A second model provider.** `adapters/claude.ts` is an adapter in name, but `ClaudeApiError`
  and its `kind` union are woven through both reporting layers. The seam is at the wrong depth for this.
- **Concurrency.** Each call is sequential, and the in-flight lock is a module-level `Set`
  that assumes one Obsidian process; a second caller on the same note is turned away
  as `locked`, not queued.
- **Trusting model output.** Several guards exist because a well-formed response can still
  be useless — a whitespace description, a quoted title that unwraps to nothing. Judge the
  value that would actually be written, never the raw field.

## Uncertainties

Where I am inferring from code, and where the code is in tension with any story I can tell.

- **`main.ts` is still untested, and the fix for that is contested.** `decideLoad` /
  `decideSave` were extracted so the forward-schema rule could be tested without
  constructing a `Plugin`. That covers the branches and the notice strings; it does not
  cover `main.ts`, where two assignments and a call still require a real `Plugin`. The
  issue proposing the extraction rated its own recommendation medium-confidence and said it
  was the one most exposed to the charge of moving complexity rather than removing it. That
  charge has not been answered, only noted.
- **`prompt.ts` now stands on one leg.** It was extracted for two reasons: shared use by a
  script, and avoiding the Obsidian-runtime parts of `metadata.ts`. The second is spent —
  `metadata.ts` no longer imports `obsidian` at runtime. Only the first remains, which is
  reason enough not to fold it back, but the module is less load-bearing than its comments
  imply.
- **The tokenizer is an approximation nobody has validated.** It counts with a regex and
  leaves spaces uncounted on purpose, approximating how BPE absorbs whitespace into the
  following word. Whether the count tracks a real tokenizer within any particular margin is
  not established anywhere, and the limit it feeds is a user-facing number.
- **The keychain's edges are known by research, not by test.** That secrets stay on the
  device that stored them is what Obsidian's behavior suggests and what the settings row
  is written around, but nothing here tests it. `app.secretStorage` has not been exercised
  on iOS at all.
- **The `heading` truncation strategy is the least principled part of `content/`.** Fenced
  code blocks, soft-wrapped continuations and headingless notes are each handled by a
  specific fix for a specific report. I could not reconstruct a rule that predicts all of
  them; it may not exist.

## A note on the comments

Comments here carry _why_, at unusual length, and frequently cite an issue number. That is
deliberate and worth preserving: most of them exist because the obvious version of the code
was tried and produced a bug in someone's actual vault. A comment explaining why there is
no Web Crypto ladder, or why both field names reset together, is what stops the next
reader restoring the obvious version. If you delete one, be sure you have understood what
it was defending against.
