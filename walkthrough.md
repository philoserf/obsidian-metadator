# Metadator Walkthrough

*2026-04-16T12:45:39Z by Showboat 0.6.1*
<!-- showboat-id: c91d8199-64ba-44cb-a99e-842b8217f311 -->

## 1. Overview

Metadator is an Obsidian plugin that generates metadata — tags, a
description, and optionally a title — for the current note by sending
its content to the Anthropic Claude API and writing the model's JSON
response into the note's YAML frontmatter.

It is a small project: one command, one API call, one frontmatter write.
The codebase is TypeScript, built with Bun, bundled as CommonJS for
Obsidian's Electron renderer, and distributed as a single `main.js`.

```bash
cat manifest.json
```

```output
{
  "id": "metadator",
  "name": "Metadator",
  "version": "2.0.2",
  "minAppVersion": "1.4.0",
  "description": "Automatically generate metadata for your notes using AI",
  "author": "Mark Ayers",
  "authorUrl": "https://github.com/philoserf",
  "isDesktopOnly": false
}
```

The `id` is how Obsidian addresses the plugin in its plugin registry.
`minAppVersion` gates the plugin on Obsidian's API surface. `isDesktopOnly`
is false: the plugin runs on mobile as well as desktop.

## 2. Project Layout

The source lives under `src/` with tests colocated. Build tooling
(`build.ts`, `version-bump.ts`) is at the root. `main.js` is committed
because Obsidian plugin distribution ships the built artifact, not
the source.

```bash
ls src/*.ts | sort
```

```output
src/callClaude.test.ts
src/generateMetadata.test.ts
src/main.test.ts
src/main.ts
src/metadata.test.ts
src/metadata.ts
src/settings.ts
src/settingsTab.test.ts
src/settingsTab.ts
src/test-preload.ts
src/utils.test.ts
src/utils.ts
```

Production modules, by role:

- `main.ts` — plugin lifecycle and the slash-command registration
- `metadata.ts` — orchestration: reads content, calls Claude, writes fields
- `settings.ts` — the settings interface and default values
- `settingsTab.ts` — the UI that renders in Obsidian's settings panel
- `utils.ts` — the Anthropic client call, tokenization, truncation, and
  frontmatter writes

The `*.test.ts` files are colocated with the code they exercise and
run with Bun's native test runner.

## 3. Build and Configuration

`build.ts` is a small Bun bundler script. It externalizes the
`obsidian` and `electron` imports (the host provides them), emits
CommonJS, and optionally watches `src/`.

```bash
sed -n '6,23p' build.ts
```

```output
async function build() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    external: ["obsidian", "electron"],
    minify: !isWatch,
  });

  if (!result.success) {
    console.error("Build failed");
    for (const message of result.logs) console.error(message);
    if (!isWatch) process.exit(1);
    return;
  }

  console.log("Build succeeded");
}
```

## 4. Plugin Entry (`main.ts`)

Obsidian loads a plugin by importing its default export (a class
extending `Plugin`) and calling `onload()`. This plugin's `onload`
does three things: load persisted settings, register the
`generate-metadata` command, and install the settings tab.

```bash
sed -n '22,39p' src/main.ts
```

```output
export default class MetadataToolPlugin extends Plugin {
  settings: MetadataToolSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "generate-metadata",
      name: "Generate metadata for current note",
      callback: async () => {
        await generateMetadata(this.app, this.settings);
      },
    });

    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
  }

  onunload(): void {}
```

Settings are persisted via Obsidian's `loadData`/`saveData`. A
`migrateSettings` pass rewrites legacy values before they merge over
the defaults. After the pre-2.0 cleanup, only the sonnet/opus model
renames remain.

```bash
sed -n '6,20p' src/main.ts
```

```output
export function migrateSettings(
  loaded: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!loaded) return loaded;

  if (loaded.anthropicModel === "claude-sonnet-4-5-20250929") {
    loaded.anthropicModel = "claude-sonnet-4-6";
  }

  if (loaded.anthropicModel === "claude-opus-4-5-20251101") {
    loaded.anthropicModel = "claude-opus-4-6";
  }

  return loaded;
}
```

## 5. Settings Data Model (`settings.ts`)

The settings interface is the full public surface the user sees.
Field names, the model, truncation behavior, and update policy are
all captured here. `DEFAULT_SETTINGS` is what fresh installs get and
what `loadSettings` falls back to for any missing keys.

```bash
sed -n '1,26p' src/settings.ts
```

```output
export interface MetadataToolSettings {
  anthropicApiKey: string;
  anthropicModel: string;

  // Field names in frontmatter
  tagsFieldName: string;
  descriptionFieldName: string;
  titleFieldName: string;

  // Feature toggles
  enableTitle: boolean;
  debugLogging: boolean;

  // Content truncation
  truncateContent: boolean;
  contentTokenLimit: number;
  truncateMethod: "head_only" | "head_tail" | "heading";

  // Update behavior
  updateMethod: "always_regenerate" | "preserve_existing";

  // Prompts
  tagsPrompt: string;
  descriptionPrompt: string;
  titlePrompt: string;
}
```

Two settings drive the meaningful branching downstream:

- `updateMethod` — `"always_regenerate"` updates every field on every
  run; `"preserve_existing"` only fills empty fields
- `truncateMethod` — `head_only`, `head_tail`, or `heading`;
  determines how the note content is cut down to `contentTokenLimit`
  before being sent to the API

## 6. Command Handler (`generateMetadata`)

The slash-command callback delegates straight to `generateMetadata`
in `metadata.ts`. This is the function that decides whether an API
call is warranted at all.

```bash
sed -n '163,198p' src/metadata.ts
```

```output
export async function generateMetadata(
  app: App,
  settings: MetadataToolSettings,
): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Please open a file first");
    return;
  }

  if (file.extension !== "md") {
    new Notice("Current file is not a markdown file");
    return;
  }

  if (!settings.anthropicApiKey) {
    new Notice(
      "Please configure your Anthropic API key in Settings → Metadator",
      8000,
    );
    return;
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};

  const updateAll = settings.updateMethod === "always_regenerate";

  // Check if we need to call Claude for metadata
  const needsMetadata =
    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    (settings.enableTitle &&
      isEmptyValue(frontMatter[settings.titleFieldName])) ||
    updateAll;

```

The guards short-circuit on an unopened file, a non-markdown file, or
a missing API key. `needsMetadata` is the decision gate: if any
configured frontmatter field is empty — or if `updateMethod` is
`always_regenerate` — the function proceeds to call Claude. Otherwise
the command is a no-op.

When it does proceed, errors from the downstream call route through
a single catch that delegates to `notifyApiError`.

```bash
sed -n '199,216p' src/metadata.ts
```

```output
  if (needsMetadata) {
    try {
      const hasChanges = await addMetadataWithClaude(
        app,
        file,
        settings,
        frontMatter,
        updateAll,
      );
      if (hasChanges) {
        new Notice("Metadata updated successfully");
      }
    } catch (error) {
      notifyApiError(error);
      console.error("generateMetadata error:", error);
    }
  }
}
```

## 7. Prompt Construction (`buildPrompt`)

The prompt is assembled in two pieces: a system message that tells
Claude what to produce, and a user message that wraps the article
text in `<article>` XML tags so the model can distinguish instructions
from content.

```bash
sed -n '43,76p' src/metadata.ts
```

```output
export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): PromptParts {
  const systemParts = [
    "Generate metadata for the provided article. Requirements:",
    "",
    `1. Tags: ${settings.tagsPrompt}`,
    "",
    `2. Description: ${settings.descriptionPrompt}`,
  ];

  const jsonFields: string[] = [
    '"tags": "tag1,tag2,tag3"',
    '"description": "brief summary"',
  ];

  if (settings.enableTitle) {
    systemParts.push("", `3. Title: ${settings.titlePrompt}`);
    jsonFields.push('"title": "article title"');
  }

  systemParts.push(
    "",
    "Return only the following JSON format:",
    `{`,
    `    ${jsonFields.join(",\n    ")}`,
    `}`,
  );

  const userMessage = `<article>\n${contentStr}\n</article>`;

  return { system: systemParts.join("\n"), userMessage };
}
```

The title section and its JSON field are omitted entirely when
`enableTitle` is false — the model is never asked for a field the
user doesn't want written. This is reflected in the integration test
"does not generate title when enableTitle is false".

## 8. The API Call (`callClaude`)

`callClaude` is the thin boundary between this plugin and the
Anthropic SDK. It instantiates the client with
`dangerouslyAllowBrowser: true` (Obsidian runs in an Electron
renderer, not a real browser — the SDK's CORS guard does not apply)
and issues a single `messages.create`.

```bash
sed -n '1,33p' src/utils.ts
```

```output
import Anthropic from "@anthropic-ai/sdk";
import type { App, TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";

// Output budget for the model's JSON response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;

export async function callClaude(
  system: string,
  userMessage: string,
  settings: MetadataToolSettings,
): Promise<string> {
  // Safe in Obsidian's Electron renderer — no browser security concerns apply
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  const message = await anthropic.messages.create({
    model: settings.anthropicModel,
    max_tokens: MAX_RESPONSE_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  if (message.content.length > 0 && message.content[0].type === "text") {
    return message.content[0].text;
  }

  throw new Error("No text content in response");
}

```

Note the separation of concerns: `callClaude` throws. It does not show
notices, does not catch SDK errors, does not translate them to UI. All
of that lives in the orchestration layer (`metadata.ts`), which keeps
`utils.ts` free of Obsidian UI dependencies and lets the tests exercise
`callClaude` with plain mocked errors.

`MAX_RESPONSE_TOKENS` is a named constant so readers do not confuse it
with `settings.contentTokenLimit` — one bounds the model's JSON output,
the other bounds the note content sent in.

## 9. Error Routing (`notifyApiError`)

When `callClaude` throws, the error bubbles up to `generateMetadata`'s
catch, which hands it to `notifyApiError`. This function is the single
place where Anthropic error classes are mapped to user-facing notices.

```bash
sed -n '6,30p' src/metadata.ts
```

```output
function notifyApiError(error: unknown): void {
  if (error instanceof Anthropic.AuthenticationError) {
    new Notice(
      "Authentication failed. Please check your API key in Settings → Metadator",
      8000,
    );
  } else if (error instanceof Anthropic.RateLimitError) {
    new Notice(
      "Rate limit exceeded. Please wait a moment and try again.",
      8000,
    );
  } else if (error instanceof Anthropic.InternalServerError) {
    new Notice(
      "API is currently overloaded. Please try again in a moment.",
      8000,
    );
  } else if (error instanceof Anthropic.APIError) {
    new Notice(`API error: ${error.message}`, 8000);
  } else {
    new Notice(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      8000,
    );
  }
}
```

## 10. Response Parsing (`parseMetadataResponse`)

Claude's response is a JSON object embedded somewhere in a string. In
practice the response is often clean JSON, but sometimes it is wrapped
in code fences or surrounded by prose. The parser handles all three
cases.

```bash
sed -n '88,126p' src/metadata.ts
```

```output
export function parseMetadataResponse(
  response: string,
): MetadataResponse | null {
  const result = tryParseFromText(response);
  if (result) return result;

  // Fall back to extracting from code fences
  const fenceMatch = response.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return tryParseFromText(fenceMatch[1]);
  }

  return null;
}

function tryParseFromText(text: string): MetadataResponse | null {
  // Collect all valid candidates, prefer the last one (LLMs put the answer last)
  let best: MetadataResponse | null = null;
  for (const m of text.matchAll(/{[\s\S]*?}/g)) {
    try {
      const parsed: unknown = JSON.parse(m[0]);
      if (isValidMetadataResponse(parsed)) best = parsed;
    } catch {
      // not valid JSON, try next match
    }
  }
  if (best) return best;
  // Fall back to greedy match in case the valid JSON contains nested braces
  const greedy = text.match(/{[\s\S]*}/);
  if (greedy) {
    try {
      const parsed: unknown = JSON.parse(greedy[0]);
      if (isValidMetadataResponse(parsed)) return parsed;
    } catch {
      // not valid JSON
    }
  }
  return null;
}
```

The non-greedy regex `/{[\s\S]*?}/g` collects every brace-pair
candidate in the text, each is tried with `JSON.parse`, and the last
valid one wins. This matters because Claude sometimes writes an
example JSON early in the response before the real answer — the test
suite has a specific case for that bug.

If no candidate parses, a greedy `/{[\s\S]*}/` fallback catches
responses where the real JSON contains nested braces (a value that is
itself JSON-shaped). The `isValidMetadataResponse` type guard
enforces the expected field types before accepting a parse.

## 11. Content Extraction and Truncation (`utils.ts`)

Before the API call, the note is read and optionally truncated to
fit within `contentTokenLimit` "tokens" — a custom per-character
tokenization that treats CJK ideographs, Latin words, ASCII and CJK
punctuation, and newlines each as one token. This is not the model's
actual tokenizer; it is a cheap approximation chosen to bound cost.

```bash
sed -n '33,59p' src/utils.ts
```

```output

export function splitIntoTokens(str: string): string[] {
  // CJK ideographs → one token each (they carry meaning per character)
  // Latin words/numbers → one token per word (whitespace-delimited)
  // Punctuation (ASCII + CJK) → individual tokens (preserves structure)
  // Newlines → tokens (headings and paragraphs depend on line breaks)
  const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g;
  const tokens = str.match(regex);
  return tokens || [];
}

export function joinTokens(tokens: string[]): string {
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "\n") {
      result += token;
    } else if (/[\u4e00-\u9fa5]|[.,!?;，。！？；#]/.test(token)) {
      result += token;
    } else {
      const prevToken = i > 0 ? tokens[i - 1] : undefined;
      const needsSpace = i > 0 && prevToken !== "\n";
      result += (needsSpace ? " " : "") + token;
    }
  }
  return result.trim();
}
```

`joinTokens` is the inverse, reconstructing text with correct spacing
— no space before punctuation, no space between CJK characters, and
no space after a newline.

Three truncation strategies are available. `head_only` keeps the
first N tokens. `head_tail` keeps the first 80% of the budget and
the last 20%, joined with an ellipsis line. `heading` extracts the
outline (every `#`-prefixed line plus the first paragraph under
each) and fills the remaining budget with the document body.

```bash
sed -n '61,79p' src/utils.ts
```

```output
export function truncateHeadOnly(tokens: string[], limit: number): string {
  const truncated = tokens.slice(0, limit);
  const suffix = truncated.length < tokens.length ? "..." : "";
  return `${joinTokens(truncated)}${suffix}`;
}

export function truncateHeadTail(tokens: string[], limit: number): string {
  if (limit >= tokens.length) {
    return joinTokens(tokens);
  }
  const left = Math.max(1, Math.floor(limit * 0.8));
  const right = Math.max(0, limit - left);
  const leftTokens = tokens.slice(0, left);
  if (right <= 0) {
    return joinTokens(leftTokens);
  }
  const rightTokens = tokens.slice(-right);
  return `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
}
```

The `heading` strategy is more involved. It walks the note line by
line, keeping headings and the first paragraph under each, then
truncates to fit the budget and labels the two sections (`Outline:`
and `Body:`) so the model can tell them apart.

```bash
sed -n '81,128p' src/utils.ts
```

```output
export function truncateHeading(
  contentStr: string,
  tokens: string[],
  limit: number,
): string {
  const rawLines = contentStr.split("\n");
  const newLines: string[] = [];
  let captureNextParagraph = false;
  let tokenCursor = 0;
  // Exclusive index into `tokens` just past the last line the outline consumed.
  // Used as the body start so body never overlaps or misaligns with the
  // reconstructed outline's own token count.
  let bodyStart = 0;

  for (const line of rawLines) {
    const lineTokens = splitIntoTokens(line);
    const nextCursor = tokenCursor + lineTokens.length + 1;

    if (line.startsWith("#")) {
      newLines.push(line);
      captureNextParagraph = true;
      bodyStart = nextCursor;
    } else if (captureNextParagraph && line.trim() !== "") {
      const truncated = lineTokens.slice(0, 30);
      const suffix = truncated.length < lineTokens.length ? "..." : "";
      newLines.push(`${joinTokens(truncated)}${suffix}`);
      captureNextParagraph = false;
      bodyStart = nextCursor;
    }

    tokenCursor = nextCursor;
  }

  const result = newLines.join("\n");
  const outlineTokens = splitIntoTokens(result);
  if (outlineTokens.length > limit) {
    return joinTokens(outlineTokens.slice(0, limit));
  }

  const remainingTokens = limit - outlineTokens.length;
  const bodyTokens = tokens.slice(bodyStart, bodyStart + remainingTokens);
  const bodyText = joinTokens(bodyTokens);
  if (bodyText !== "") {
    const suffix = bodyStart + remainingTokens < tokens.length ? "..." : "";
    return `Outline: \n${result}\n\nBody: ${bodyText}${suffix}`;
  }
  return `Outline: \n${result}`;
}
```

```bash
sed -n '130,159p' src/utils.ts
```

```output
export async function getContent(
  app: App,
  file: TFile,
  limit: number = 1000,
  method: "head_only" | "head_tail" | "heading" = "head_only",
): Promise<string> {
  let contentStr = await app.vault.read(file);

  if (contentStr.length === 0) {
    return "";
  }

  if (limit <= 0) {
    return contentStr;
  }

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit) {
    if (method === "head_tail") {
      contentStr = truncateHeadTail(tokens, limit);
    } else if (method === "head_only") {
      contentStr = truncateHeadOnly(tokens, limit);
    } else if (method === "heading") {
      contentStr = truncateHeading(contentStr, tokens, limit);
    }
  }

  return contentStr;
}
```

`getContent` orchestrates the three strategies. A non-positive
`limit` returns the full note untouched (used when
`settings.truncateContent` is false). Otherwise the strategy runs
only if the content actually exceeds the budget.

## 12. Frontmatter Writes (`updateFrontMatter`)

All writes go through Obsidian's official
`app.fileManager.processFrontMatter` hook, which the platform serializes
and integrates with the metadata cache. Three methods are supported:

- `keep` — write only if the field is currently absent
- `update` — overwrite the field with the new value
- `append` — for array fields: normalize current value to an array,
  concatenate, and deduplicate

The function is overloaded so the type system rejects misuse: `"append"`
requires a `string[]`, `"update"` accepts `string | boolean` only, and
`"keep"` tolerates the full shape since it writes only when the field is
absent. Every call returns a boolean indicating whether the frontmatter
was actually mutated — so the caller knows a no-op append (all tags
already present) from a real one.

```bash
sed -n '161,214p' src/utils.ts
```

```output
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string[],
  method: "append",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean,
  method: "update",
): Promise<boolean>;
export function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "keep",
): Promise<boolean>;
export async function updateFrontMatter(
  app: App,
  file: TFile,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): Promise<boolean> {
  let changed = false;
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      const values = value as string[];
      const existing = frontmatter[key];
      const base = Array.isArray(existing)
        ? existing
        : existing != null
          ? [String(existing)]
          : [];
      const merged = Array.from(new Set(base.concat(values)));
      changed =
        !Array.isArray(existing) ||
        base.length !== merged.length ||
        base.some((item, i) => item !== merged[i]);
      frontmatter[key] = merged;
    } else if (method === "update") {
      if (frontmatter[key] !== value) changed = true;
      frontmatter[key] = value;
    } else if (frontmatter[key] === undefined) {
      frontmatter[key] = value;
      changed = true;
    }
  });
  return changed;
}
```

## 13. Update Orchestration (`addMetadataWithClaude`)

This is the glue that ties everything together: pull content, build
prompt, call Claude, parse, and write. The "Generating metadata…"
spinner is shown for the duration of the API call via a `try/finally`
so it always clears, including on thrown errors.

```bash
sed -n '218,258p' src/metadata.ts
```

```output
async function addMetadataWithClaude(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  force: boolean = false,
): Promise<boolean> {
  const contentStr = settings.truncateContent
    ? await getContent(
        app,
        file,
        settings.contentTokenLimit,
        settings.truncateMethod,
      )
    : await getContent(app, file, -1, "head_only");

  const { system, userMessage } = buildPrompt(contentStr, settings);

  if (settings.debugLogging) {
    console.log("[Metadator] System:", system);
    console.log("[Metadator] User message:", userMessage);
  }

  const notice = new Notice("Generating metadata...", 0);
  let response: string;
  try {
    response = await callClaude(system, userMessage, settings);
  } finally {
    notice.hide();
  }

  if (settings.debugLogging) {
    console.log("[Metadator] Response:", response);
  }

  if (!response) {
    return false;
  }

  const metadata: MetadataResponse = parseMetadataResponse(response) ?? {};

```

The three fields (tags, description, title) each build a
`FieldUpdate` entry, then a single loop applies them. The per-field
`updateMethod` differs: tags are merged with `append`, while
description and title overwrite with `update`. Either way,
`resolveUpdateMethod` decides whether to act on this field at all —
if `force` is true (i.e. `updateMethod === "always_regenerate"`)
every field runs; otherwise only empty fields do.

```bash
sed -n '278,315p' src/metadata.ts
```

```output
          u.value,
          "append",
        );
      }
      return await updateFrontMatter(app, file, u.fieldName, u.value, "update");
    } catch (error) {
      new Notice(
        `Failed to write ${u.fieldName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`updateFrontMatter error (${u.fieldName}):`, error);
      return false;
    }
  }

  const updates: FieldUpdate[] = [];

  if (metadata.tags) {
    updates.push({
      fieldName: settings.tagsFieldName,
      value: parseTags(metadata.tags),
      updateMethod: "append",
    });
  }
  if (metadata.description) {
    updates.push({
      fieldName: settings.descriptionFieldName,
      value: metadata.description,
      updateMethod: "update",
    });
  }
  if (settings.enableTitle && metadata.title) {
    updates.push({
      fieldName: settings.titleFieldName,
      value: stripSurroundingQuotes(metadata.title),
      updateMethod: "update",
    });
  }

```

`writeField` is a local helper inside `addMetadataWithClaude` that
captures `app`, `file`, and `notifyApiError`-style error reporting
in one place. Failures to write a specific field show a notice and
return false; the outer function continues with the remaining
fields.

## 14. Settings UI (`settingsTab.ts`)

The UI is a straightforward Obsidian `PluginSettingTab` — one
`new Setting(containerEl)` per field. The API key input is masked
by setting `text.inputEl.type = "password"`. Dependent settings (the
truncation inputs, the title-field inputs) are disabled when their
parent toggle is off.

This file is intentionally thin: it reads and writes
`this.plugin.settings` directly and calls `saveSettings` on every
`onChange`. There is no debouncing.

## 15. Test Layout

Tests are colocated under `src/` and run with Bun's native test
runner. A preload file stubs the subset of Obsidian's API the tests
touch (the `Notice` class and the base classes) so that importing
`obsidian` does not blow up outside of the real host.

```bash
cat src/test-preload.ts
```

```output
import { mock } from "bun:test";

mock.module("obsidian", () => ({
  Plugin: class Plugin {},
  Notice: class Notice {
    hide() {}
  },
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
}));
```

```bash
grep -c '^  test(\|^    test(\|^  it(' src/*.test.ts
```

```output
src/callClaude.test.ts:8
src/generateMetadata.test.ts:7
src/main.test.ts:5
src/metadata.test.ts:47
src/settingsTab.test.ts:7
src/utils.test.ts:49
```

The suites split into pure-function unit tests (parsing,
tokenization, truncation, update-method resolution), callClaude
error handling, and `generateMetadata` integration tests that mock
the Anthropic SDK module and drive the full command flow end to end.

## 16. Concerns

A few items worth noting, in decreasing order of priority.

**UI test coverage for `settingsTab.display()` is absent.** The
`settingsTab.test.ts` file re-implements the validation logic as
plain functions rather than exercising the actual UI code. The
whole 244-line `display()` method runs untested. This is a common
pattern for Obsidian plugins — the host provides no easy DOM
harness — but it is still a real gap.

**The "token" counter is not the model's tokenizer.** `splitIntoTokens`
is a cheap per-character approximation. It will undercount for
languages the regex doesn't cover (e.g. Cyrillic, Thai, Hebrew), and
it diverges from the actual Claude tokenizer by a wide margin. Users
who rely on `contentTokenLimit` to control cost should treat it as a
rough bound, not a precise ceiling.

**Response parsing falls back twice.** The non-greedy candidate
scan, the greedy whole-string match, and the code-fence extraction
all layer defensively. Each layer is documented and tested, but the
complexity reflects that LLM output shape is not under the plugin's
control. If the prompt enforced a stricter protocol (e.g., "your
entire response must be a JSON object and nothing else"), the parser
could collapse.

**No retry logic for transient failures.** A rate-limit or
`InternalServerError` surfaces a notice and the command is done.
For a user-initiated command this is fine — the user can simply run
it again — but batch callers (none exist today) would benefit from
exponential backoff.

**`contentTokenLimit` default of 1000 is conservative.** Modern
Claude models accept 200K+ input tokens. The default is set low to
protect API cost, but the per-character heuristic above already
overestimates. A user who enables `truncateContent` on large notes
will get a much smaller slice than the budget implies.

**`main.js` committed to the repo is required by Obsidian's
plugin distribution convention** — worth flagging to readers
surprised by build artifacts in git. Release builds are produced by
the `release.yml` workflow on tag push.
