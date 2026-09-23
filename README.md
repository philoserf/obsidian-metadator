# Metadator

![Status: Stable](https://img.shields.io/badge/Status-Stable-brightgreen.svg)

Generate metadata (tags, description, title) for [Obsidian](https://obsidian.md/) notes using the [Anthropic Claude API](https://www.anthropic.com/api).

## You probably shouldn't install this

This is personal tooling, not a general-purpose plugin. It is opinionated in ways that only make sense for one person's workflow:

- **Single user.** The only known installation is the maintainer's. Breaking changes can ship without migration paths (see `CHANGELOG.md` — 2.0.0 renamed `maxTokens` to `contentTokenLimit`, 2.0.1 dropped all pre-2.0 settings migrations).
- **Paid API required.** The plugin calls Anthropic's Claude API. You supply and pay for your own API key; there is no free tier, no provider abstraction and no local-model path — swapping in another API means rewriting `src/adapters/claude.ts`.
- **Frontmatter only.** Generated `tags`, `description`, and `title` are written to YAML frontmatter via Obsidian's `processFrontMatter()`. There is no inline-tag or body-content mode.
- **It will spend your money in bulk if you let it.** Besides the single-note command there is a recursive folder action, and a large folder means hundreds of billed API calls. It is gated by a confirm dialog and the `maxBulkFiles` setting, but the gate is a checkbox you can tick past.
- **No issue triage for feature requests.** Bugs are welcome; feature requests from other users will almost always be closed as out-of-scope.

If you want something similar, the code is MIT-licensed — fork it and adapt. Don't expect upstream to accommodate your workflow.

## How It Works

There are two ways in.

**One note.** Run **Generate metadata for current note** on the active note.

**A folder.** Right-click a folder and choose **Generate metadata (recursive)**. Every markdown file in the tree is scanned and sorted into those that will change and those that will not; a confirm dialog reports both counts, the write policy, and a worst-case API-call estimate that includes retries. Above `maxBulkFiles` files-that-will-change (default 500) the confirm button is disabled until you tick an override. A progress dialog can cancel mid-run, and a summary reports what changed, what was skipped and what errored. The run halts early on an authentication error, and after a streak of consecutive failures of the same kind, rather than making hundreds of doomed calls.

Both paths do the same thing per note. The plugin reads the note body — frontmatter stripped, optionally truncated — and sends it to Claude with a `submit_metadata` tool schema, requiring a structured tool call rather than asking for JSON in prose. The tool's input is type-checked before anything is written, and a response cut off at the token limit is rejected outright instead of writing a half-finished description. When the note already has tags, they are sent along in their own block and the model is asked to reconcile them rather than draw a fresh set.

The results are written to `tags`, `description` and (optionally) `title` in YAML frontmatter, each according to its own write policy.

Three groups of settings shape what happens on each run.

### Write policy

One policy per field, because the three fields are different kinds of value. A single global setting could not serve them: the only value that would clean up a sprawling tag list also rewrote every title unconditionally.

All three offer the same choice, so "always regenerate" is one idea you turn on per field rather than a behavior wearing a different name on each.

| Field         | Options                             | Default      |
| ------------- | ----------------------------------- | ------------ |
| `tags`        | `regenerate` · `merge` · `preserve` | `regenerate` |
| `description` | `regenerate` · `preserve`           | `regenerate` |
| `title`       | `regenerate` · `preserve`           | `preserve`   |

- **`regenerate`** replaces what is there with what the model returned. For `tags` that means the reconciled set — the note's current tags are sent with the request, so those that still fit are kept and those that no longer apply are dropped. It is the only policy that can _remove_ a tag.
- **`merge`** adds to what is already there and never removes, so tag lists grow on every run. Offered for `tags` only; it is meaningless for a value that is not a set.
- **`preserve`** writes only when the field is empty, re-checking at write time so a value typed during the request is not clobbered.

`title` defaults to `preserve` because it is frequently kept in sync by another plugin or relied on by a publisher, where a silent rewrite changes a note's public identity.

### Truncation method

Large notes are truncated before being sent to Claude so prompt size stays bounded. The token count uses a regex over words, punctuation, CJK characters, and newlines, with a catch-all so emoji and markdown syntax count too.

| Method                | Behavior                                            |
| --------------------- | --------------------------------------------------- |
| `head_only` (default) | First N tokens                                      |
| `head_tail`           | 80% from the start + 20% from the end               |
| `heading`             | Outline plus the first paragraph under each heading |

Truncation can be disabled entirely (`truncateContent: false`), in which case the full note is sent.

### Title generation

Title generation is toggleable (`enableTitle`). When disabled, the plugin omits the title field from both the prompt and the frontmatter write — so an existing `title` in the note is never touched.

## Privacy

This plugin requires an Anthropic API key and transmits note content to a third-party API.

- **Note content is sent to Anthropic.** Every run transmits the note's body (frontmatter stripped, possibly truncated) and its existing tags to Anthropic's API. Do not run this plugin on notes whose contents you would not paste into a web form.
- **The folder action sends every note in the tree.** A recursive run transmits the body of each markdown file under the folder, not only the one you have open. Check what is in a folder before running it.
- **API key storage.** The Anthropic API key is stored in Obsidian's plugin data file (`data.json`) as plaintext. This is an Obsidian platform constraint — there is no encrypted storage API. Anyone with file system access to your vault can read the key.
- **Recommendations:** Rotate the key periodically and set a usage cap on it in the Anthropic console. On shared devices, be aware that the key is accessible on disk.

## Alternatives

- [Auto Classifier](https://github.com/HyeonseoNam/auto-classifier) — AI-powered tag and frontmatter generation with multiple provider support.
- [Tag Wrangler](https://github.com/pjeby/tag-wrangler) — manual tag management and renaming (no AI).
