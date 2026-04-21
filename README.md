# Metadator

Generate metadata (tags, description, title) for [Obsidian](https://obsidian.md/) notes using the [Anthropic Claude API](https://www.anthropic.com/api).

## You probably shouldn't install this

This is personal tooling, not a general-purpose plugin. It is opinionated in ways that only make sense for one person's workflow:

- **Single user.** The only known installation is the maintainer's. Breaking changes ship without migration paths (see `CHANGELOG.md` — 2.0.0 renamed `maxTokens` to `contentTokenLimit`, 2.0.1 dropped all pre-2.0 settings migrations).
- **Paid API required.** The plugin calls Anthropic's Claude API. You supply and pay for your own API key; there is no free tier and no alternative provider.
- **Frontmatter only.** Generated `tags`, `description`, and `title` are written to YAML frontmatter via Obsidian's `processFrontMatter()`. There is no inline-tag or body-content mode.
- **One command, one note.** The plugin operates on the active note. There is no multi-note batch, vault-wide sweep, or folder queue.
- **No issue triage for feature requests.** Bugs are welcome; feature requests from other users will almost always be closed as out-of-scope.

If you want something similar, the code is MIT-licensed — fork it and adapt. Don't expect upstream to accommodate your workflow.

## How It Works

Run **Generate metadata for current note** on the active note. The plugin reads the note body, optionally truncates it, sends it to Claude with a JSON-return prompt, parses the response, and writes `tags`, `description`, and (optionally) `title` back to frontmatter.

Three settings shape what happens on each run.

### Update method

| Method                        | Behavior                                       |
| ----------------------------- | ---------------------------------------------- |
| `preserve_existing` (default) | Only populate fields that are missing or empty |
| `always_regenerate`           | Overwrite every field on every run             |

### Truncation method

Large notes are truncated before being sent to Claude so prompt size stays bounded. The token count uses a regex over words, punctuation, CJK characters, and newlines.

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

- **Note content is sent to Anthropic.** Every run transmits the active note's body (possibly truncated) to Anthropic's API. Do not run this plugin on notes whose contents you would not paste into a web form.
- **API key storage.** The Anthropic API key is stored in Obsidian's plugin data file (`data.json`) as plaintext. This is an Obsidian platform constraint — there is no encrypted storage API. Anyone with file system access to your vault can read the key.
- **Recommendations:** Rotate the key periodically and set a usage cap on it in the Anthropic console. On shared devices, be aware that the key is accessible on disk.
