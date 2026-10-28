# Metadator

![Status: Stable](https://img.shields.io/badge/Status-Stable-brightgreen.svg)

Generate metadata (description, title) for [Obsidian](https://obsidian.md/) notes using the [Anthropic Claude API](https://www.anthropic.com/api).

## You probably shouldn't install this

This is personal tooling, not a general-purpose plugin. It is opinionated in ways that only make sense for one person's workflow:

- **Single user.** The only known installation is the maintainer's. Breaking changes can ship without migration paths (see `CHANGELOG.md` — 2.0.0 renamed `maxTokens` to `contentTokenLimit`, 2.0.1 dropped all pre-2.0 settings migrations).
- **Paid API required.** The plugin calls Anthropic's Claude API. You supply and pay for your own API key; there is no free tier, no provider abstraction and no local-model path — swapping in another API means rewriting `src/adapters/claude.ts`.
- **Frontmatter only.** Generated `description`, `title` and `eyebrow` are written to YAML frontmatter via Obsidian's `processFrontMatter()`. There is no body-content mode.
- **No tags.** Tag generation was removed (#310). The plugin neither reads nor writes `tags`; whatever a note already holds there is left alone.
- **One note per action.** There is no folder or bulk run (removed in #311); covering many notes means scripting the CLI below, one billed call per note.
- **No issue triage for feature requests.** Bugs are welcome; feature requests from other users will almost always be closed as out-of-scope.

If you want something similar, the code is MIT-licensed — fork it and adapt. Don't expect upstream to accommodate your workflow.

## How It Works

There are two ways in.

**One note.** Run **Generate metadata for current note** on the active note.

**From the command line.** `obsidian metadator:generate path="Inbox/Note.md"` runs the one-note path on the named file, with Obsidian open, and prints one JSON object: `status` (`changed`, `skipped` or `error`), `file`, a `reason` when it did not change, and the note's `title`, `description` and `eyebrow` as they stand after the run. One file per call. Add `dry-run` to see what would be written without writing it: `status` is `preview` and only the fields a run would write appear, with the values it would write. The call is still made and billed.

Both do the same thing. The plugin reads the note body — frontmatter stripped, optionally truncated — and sends it to Claude with a `submit_metadata` tool schema, requiring a structured tool call rather than asking for JSON in prose. The tool's input is type-checked before anything is written, and a response cut off at the token limit is rejected outright instead of writing a half-finished description.

The results are written to `description`, `title` and `eyebrow` in YAML frontmatter — whichever are switched on — each according to its own write policy.

Three groups of settings shape what happens on each run.

### Fields

Each field has its own switch: `enableDescription` and `enableTitle`, both on by default, and `enableEyebrow`, off by default. A field that is off is left out of the prompt and the tool schema, so the model is never asked for it, and it is never written — an existing value in the note stays exactly as it is, neither overwritten nor deleted. Its field name, prompt and write policy are grayed out in the settings tab, and its field name no longer counts when the plugin checks that the names differ.

**`eyebrow` is a choice field.** It names a note's form from a fixed list, `Poem`, `Fiction` and `Quotation` by default (`eyebrowValues`, edited as one comma-separated line), and most notes, essays above all, get no value at all. The tool schema offers the list plus an empty answer for none; anything else the model returns is not written, and never costs the other fields their answers. With it on, a note without an eyebrow is never "already populated", since an absent eyebrow is a valid state, so every run makes a call.

With every field off there is nothing to generate. The command says so in a notice, and `metadator:generate` returns an error; neither calls the API.

### Write policy

One policy per field, because the fields are kept differently: a description is cheap to replace, while a title or a form is often a decision made elsewhere. All offer the same choice, so "always regenerate" is one idea you turn on per field rather than a behavior wearing a different name on each.

| Field         | Options                   | Default      |
| ------------- | ------------------------- | ------------ |
| `description` | `regenerate` · `preserve` | `regenerate` |
| `title`       | `regenerate` · `preserve` | `preserve`   |
| `eyebrow`     | `regenerate` · `preserve` | `preserve`   |

- **`regenerate`** replaces what is there with what the model returned.
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

## Privacy

This plugin requires an Anthropic API key and transmits note content to a third-party API.

- **Note content is sent to Anthropic.** Every run transmits the note's body (frontmatter stripped, possibly truncated) to Anthropic's API. Do not run this plugin on notes whose contents you would not paste into a web form.
- **API key storage.** The key is kept in Obsidian's keychain (Settings → Keychain), which encrypts it with the operating system's secure storage; `data.json` holds only the secret's name. Obsidian does not sync keychain secrets, so choose or enter the key once on each device you run the plugin from; the API key row names the secret it expects and says when this device does not have it. Requires Obsidian 1.13.0.
- **Upgrading.** A plaintext key in `data.json` from before the keychain is ignored and dropped on the next save; it is no longer moved into the keychain (#316). Enter the key in Settings → Keychain on each device.
- **Recommendations:** Rotate the key periodically and set a usage cap on it in the Anthropic console.

## Alternatives

- [Auto Classifier](https://github.com/HyeonseoNam/auto-classifier) — AI-powered tag and frontmatter generation with multiple provider support, for anyone who wants tags.
