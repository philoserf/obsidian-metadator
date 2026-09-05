# A theory of Metadator

Written for whoever inherits this next. It is not a tour of the files — `walkthrough.md`
does that, and follows the call chain properly. This is the understanding you need in order
to change the system without breaking something that looks unrelated.

## What it is for

A note in Obsidian is two things stacked in one file: a body the user wrote, and a
frontmatter block of facts _about_ the body. This plugin derives the second from the first
by asking Claude. Tags, a description, and optionally a title.

That sounds like a pure function — text in, three strings out — and if it were, most of this
codebase would be unnecessary. It is not, because of one fact that shapes nearly everything
here:

**The note is a live document, and the API call takes up to a minute.**

The user has that note open. They can type into it, delete a field, rename the file, or
trigger a second generation on it while the first is still in flight. A folder run compounds
this: hundreds of files, unattended, with the user free to work in the vault the whole time.

Almost every mechanism in this system that looks like over-engineering is an answer to that
gap. If you hold only one idea from this document, hold that one.

## The gap, and what guards it

Trace the defensive machinery and it all converges on the same window.

`adapters/frontmatter.ts` has a write method called `update_if_empty` that re-reads the
frontmatter _inside_ Obsidian's `processFrontMatter` callback rather than trusting the
caller. That looks like paranoia until you see what it replaced: the decision "this field is
empty, safe to fill" used to be made from a `metadataCache` snapshot taken before the
request. A user who typed a description during the call got it silently overwritten. The
re-check is the fix, and it is why the caller must not "simplify" this back into a plain
`update`.

`emptyValue.ts` is a single function in its own module, which reads as excessive until you
notice it has exactly two callers: the code deciding whether to generate, and the code
deciding whether to write. Those two run a minute apart and must reach the same verdict on
the same value. Putting the definition in one place is the whole point of the module; it is
not a utility drawer.

`inFlight.ts` is a module-level `Set` of paths — global mutable state, normally a smell —
because two independent entry points (the command and the folder run) can reach the same
file, and the guard has to span both. It sits inside `generateMetadataForFile`, the one
chokepoint they share. Guarding the command callback instead would look tidier and would
miss the case that matters.

The same function captures `file.path` into a local before the request and releases _that_
string afterward. Obsidian mutates `TFile.path` in place on rename, so re-reading it after
the call can release a key nobody holds and strand the original forever.

And the `keep` write method does not write. It used to fill the field when it was absent,
which can only happen if the user deleted it during the request — so the plugin restored
something they had just removed. Now the caller skips the write entirely, because
`processFrontMatter` serializes and writes the file back on _every_ call whether the
callback mutated anything or not, and a no-op write still bumps mtime and fires a vault
event.

A maintainer who does not hold this theory will read those four things as four unrelated
quirks and remove at least one of them.

## Token counting is cost estimation, not measurement

`content/tokens.ts` is a single regex pretending to be a BPE tokenizer. It is not trying to
match Anthropic's tokenizer and never will. Its actual job is to bound prompt size well
enough that a large note does not blow the budget, and its correctness criteria are narrower
and stranger than "accurate":

**It must not silently drop characters.** The regex once matched CJK, word runs, nine
punctuation marks and newlines — and nothing else, so emoji and ordinary markdown syntax
matched no alternative at all. They vanished from the count, and because truncation rebuilt
its output by re-joining matched tokens, they vanished from the text too. `**bold**` went
into the prompt as `bold`. The trailing `\S` catch-all exists to make every non-whitespace
character count for something.

**Counting and reconstruction want opposite things from the same array.** Counting wants CJK
split per character; reconstruction wants the original spacing back. The resolution is that
tokens carry source offsets and every truncation path rebuilds by _slicing the source
string_, never by joining token text. If you find yourself writing `tokens.map(t =>
t.text).join(...)`, stop — that is the bug this design exists to prevent.

Whitespace is deliberately uncounted, approximating how real tokenizers absorb spaces into
the following word. That is an approximation the authors chose knowingly, not an oversight.

## Failure is classified by whether it will recur

`ClaudeErrorKind` is the domain vocabulary for _reasons things fail_, and the whole bulk
policy is built on one question asked of every error: **is this about this note, or about
the run?**

- `auth` is about the run. A rejected key rejects every remaining file, so one round-trip is
  enough evidence and the run halts immediately.
- `rate_limit` and `overloaded` are about this moment. They retry on a backoff schedule, and
  they only count toward the halt streak once that whole schedule has failed — at which
  point they have stopped being a moment and become a ceiling.
- `connection` is about the network, and it is treated differently from both. It retries,
  because a Wi-Fi blip does recover, but on a shorter schedule and a shorter halt streak
  than anything else. The reason is a timing fact rather than a semantic one: a _hung_ socket
  (established, silent — unlike a refused connection, which fails fast) burns the full 60s
  timeout on each of the SDK's three internal attempts, so patience is far more expensive
  here than elsewhere.
- `api`, `unknown`, and `other` (a failure that never reached the API, such as a read-only
  vault) need five in a row of the same kind. One of those is as likely to be one bad note
  as a broken run.

The number that makes this policy legible is not in the code: retry counts multiply. Four
outer attempts times three SDK requests times a 60-second timeout is twelve minutes _per
file_ before a hung network yields anything. That product is why the connection case has its
own constants, and it is the first thing to recompute if you touch `REQUEST_TIMEOUT_MS`,
`SDK_MAX_RETRIES`, or either retry schedule.

## Three kinds of boundary, only one of them enforced

The system has three separations that look similar and are not.

**The SDK boundary is real and mechanical.** Only `adapters/claude.ts` may import
`@anthropic-ai/sdk`, and a Biome rule fails the build otherwise. Everything else consumes a
typed wrapper. This is load-bearing: SDK types would otherwise reach domain code and the
adapter would stop being replaceable.

**`data.json` is a trust boundary, not a convenience.** Users hand-edit it. `settingsMigrate.ts`
therefore treats everything it reads as hostile input — bounded strings, bounded integers,
shape-checked enums — and the shape of that file is versioned, with migrations keyed by the
version they produce. `applyMigrations` throws if a target version has no entry, so bumping
the version without writing the migration fails at plugin load rather than silently. A file
from a _newer_ plugin version is refused rather than normalized: the plugin loads defaults,
sets a flag, and `saveSettings` declines to write at all, because downgrading and saving
would destroy settings the user's newer install understands.

**The Obsidian-freedom of `prompt.ts` and `content/` is convention.** Nothing enforces it.
It exists because `obsidian` is a _types-only_ package with no runtime JavaScript, so
importing anything from a module that imports it crashes outside Obsidian. `scripts/compare-models.ts`
runs under plain `bun` and needs `buildPrompt`, so `buildPrompt` cannot live next to a
`Notice`. Note that `content/frontmatter.ts` reimplements Obsidian's own frontmatter-boundary
rule rather than calling `getFrontMatterInfo` for the same reason — a test could only ever
exercise a mock of that helper, never the code that ships. That is a deliberate trade of
authority for testability, and it is the kind of decision worth revisiting if the constraint
ever changes.

## What the shape accommodates, and what it does not

**A model released after this build.** This was decided explicitly. `anthropicModel` is
validated by _shape_, not membership in a list, and the settings field is a text input backed
by a datalist rather than a dropdown. A well-formed but unknown id reaches the API and fails
there with a clear message, which the authors judged better than silently resetting the
user's choice. Models whose families reject a forced `tool_choice` are matched by prefix
(`/^claude-(?:fable|mythos)-/`) rather than by id, so a later release in those families needs
no code change.

**A new truncation strategy.** The three that exist are three answers to "which part of a
note carries its meaning", and adding a fourth is a matter of a union member and a function.

**A new frontmatter field** would be harder than it looks. The three fields are not a
collection anywhere — they are three named settings, three named prompts, three branches in
the tool schema, three entries in the update list, and a hand-written distinctness check.
Adding a fourth means touching all of those. Whether that is a flaw or a correct refusal to
generalize over three is a judgment call; the code currently makes it, consistently.

**Per-field update policy** would require rethinking something fundamental. `updateMethod`
is one global setting with two values. There is no way to say "always regenerate tags but
preserve my titles", and the decision is threaded as a single boolean through the write path.

## Where the theory is thin

These are places I am inferring intent from code, or where the code seems to be holding two
ideas at once. Trust these paragraphs less than the ones above.

**"Change" means two different things, and the UI uses the weaker one.** The bulk confirm
modal reports "_N_ will change", counted by `classifyCandidates` via `shouldGenerate`. But
under `always_regenerate`, `shouldGenerate` returns `true` unconditionally — so `willChange`
becomes _every markdown file in the folder_, whether or not the model's output would differ
from what is already there. Meanwhile `hasChanges` in the write path means actual mutation.
The confirm modal is stating a plan and the summary is reporting an effect, and they share a
word. I do not think this is a bug so much as a vocabulary that was never pinned down, but a
user under `always_regenerate` is being shown a number that means "will be sent to the API",
not "will differ".

**`heading` truncation is outline-plus-tail, not outline-plus-everything.** The body section
starts at the token index just past the _last_ line the outline consumed, so prose sitting
between earlier headings — not captured as a first paragraph, not after the last one — is
dropped entirely. For a long structured document that is probably what you want. I could not
find a comment or test establishing it as intended rather than incidental, and it is the
behavior I would check first if someone reports that `heading` mode loses content.

**The auto-tool-choice path has never been verified against the live API.** The author says
so plainly in the commit that introduced it: the tests assert the request shape only. If
Fable- or Mythos-family models misbehave, that path is where to look, and nothing in the
suite would have caught it.

**Two clocks, deliberately, but the confirm modal only sees one.** `shouldGenerate` reads
`metadataCache`; the write re-checks live frontmatter. That split is intentional and is the
#178 fix. But a folder run's entire plan — which files will be processed, what the modal
promises — is computed from the cache clock at the start, and a long run's later files may
have changed by the time they are reached. The per-file re-check catches the dangerous case,
so this is a display-accuracy question rather than a data-safety one.

**`title: 0` is a title.** `isEmptyValue` deliberately treats numbers and booleans as
present, because folding `0` and `false` in with `""` meant such a field was judged empty
when deciding to generate and empty again when deciding to overwrite — silent data loss
under the policy that promises not to touch populated fields. The fix is right. Whether a
frontmatter `title: 0` is _meaningfully_ a title is a question the system now answers "yes"
without much evidence either way.

## One last thing about this repository

The authors record their reasoning in commit messages and `CHANGELOG.md` to an unusual
degree — the changelog entries explain the failure mode, not just the fix, and the commit
that introduced the auto-tool-choice path states its own unverified status. When something
here looks arbitrary, `git log -S` on the constant or function name is unusually likely to
return an answer. That is a property of this project worth preserving, and the cheapest way
to keep this document from going stale.
