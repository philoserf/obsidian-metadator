# Metadator — A Code Walkthrough

*2026-02-27T20:13:10Z by Showboat 0.6.1*
<!-- showboat-id: 7de5e52b-5acb-404f-9a73-d41c975eb5bf -->

## 1. What Metadator Does

Metadator is an Obsidian plugin that generates metadata — tags, description, and title — for
notes using the Anthropic Claude API. The user runs a command, the plugin sends the note's
content to Claude, parses the JSON response, and writes the results into YAML frontmatter.

The entire plugin is five source files totaling roughly 500 lines of TypeScript:

| File | Responsibility |
|------|---------------|
| `main.ts` | Plugin lifecycle, command registration, settings migration |
| `settings.ts` | Settings interface and defaults |
| `settingsTab.ts` | Settings UI panel |
| `metadata.ts` | Orchestration: prompt building, response parsing, field updates |
| `utils.ts` | Claude API calls, content truncation, frontmatter writes |

Let's look at the project layout, then walk through each file in the order data flows.

```bash
find /Users/markayers/source/mine/obsidian-metadator -maxdepth 1 -not -name node_modules -not -name .git -not -name .obsidian -not -name .claude | sort | sed "s|/Users/markayers/source/mine/obsidian-metadator/||;s|/Users/markayers/source/mine/obsidian-metadator||" | head -20
```

```output

.github
.gitignore
.issues
.planning
AGENTS.md
biome.json
build.ts
bun.lock
bunfig.toml
CLAUDE.md
LICENSE
main.js
manifest.json
package.json
README.md
scripts
src
tsconfig.json
version-bump.ts
```

```bash
ls /Users/markayers/source/mine/obsidian-metadator/src/
```

```output
main.test.ts
main.ts
metadata.test.ts
metadata.ts
settings.ts
settingsTab.ts
test-preload.ts
utils.test.ts
utils.ts
```

## 2. Build and Tooling

The build pipeline uses **Bun** for everything: bundling, testing, and script execution.
**Biome** handles formatting and linting.

```bash
sed -n "/\"scripts\"/,/^  }/p" /Users/markayers/source/mine/obsidian-metadator/package.json
```

```output
  "scripts": {
    "dev": "bun run build.ts --watch",
    "build": "bun run check && bun run build.ts",
    "check": "bun run typecheck && biome check .",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "test": "bun test",
    "deploy": "cp main.js manifest.json ~/source/mine/notes/.obsidian/plugins/metadator/",
    "validate": "bun run scripts/validate-plugin.ts",
    "version": "bun run version-bump.ts"
  },
```

`bun run validate` is the one-stop quality gate. It runs type checking, tests, Biome,
and the production build in sequence.

The build itself is a short Bun script:

```bash
cat /Users/markayers/source/mine/obsidian-metadator/build.ts
```

```output
const watch = process.argv.includes("--watch");

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: ".",
  format: "cjs",
  external: ["obsidian", "electron"],
  minify: !watch,
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

if (watch) console.log("Watching for changes...");

export {};
```

Obsidian plugins must ship as a single CommonJS file (`main.js`). The bundler marks
`obsidian` and `electron` as externals since those are provided by the host runtime.
`--watch` mode disables minification for faster rebuilds.

Tests rely on a preload shim that stubs the `obsidian` module:

```bash
cat /Users/markayers/source/mine/obsidian-metadator/bunfig.toml
```

```output
[test]
preload = ["./src/test-preload.ts"]
```

```bash
cat /Users/markayers/source/mine/obsidian-metadator/src/test-preload.ts
```

```output
import { mock } from "bun:test";

mock.module("obsidian", () => ({
  Plugin: class Plugin {},
  Notice: class Notice {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
}));
```

These are **structural stubs**, not behavioral mocks. They satisfy the module resolver
so `import { Plugin } from "obsidian"` doesn't blow up, but they don't simulate any
Obsidian behavior. Tests that touch Obsidian APIs (like `processFrontMatter`) use
hand-rolled fakes inline.

## 3. Settings — The Configuration Schema

All user-configurable values live in `settings.ts`. This is the smallest source file
and the one everything else depends on:

```bash
cat /Users/markayers/source/mine/obsidian-metadator/src/settings.ts
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

  // Content truncation
  truncateContent: boolean;
  maxTokens: number;
  truncateMethod: "head_only" | "head_tail" | "heading";

  // Update behavior
  updateMethod: "always_regenerate" | "preserve_existing";

  // Prompts
  tagsPrompt: string;
  descriptionPrompt: string;
  titlePrompt: string;
}

export const DEFAULT_SETTINGS: MetadataToolSettings = {
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6",

  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",

  enableTitle: true,

  truncateContent: true,
  maxTokens: 1000,
  truncateMethod: "head_only",

  updateMethod: "preserve_existing",

  tagsPrompt:
    "Select 3-5 relevant tags in lowercase with hyphens instead of spaces (e.g., 'knowledge-management', 'note-taking')",
  descriptionPrompt:
    "Write a concise but useful summary in 1-2 sentences that captures the main purpose and key points",
  titlePrompt:
    "Create a simple, concise title with minimal adjectives that clearly states the topic",
};
```

Three things to notice:

1. **`anthropicModel` is a plain string**, not a union type. The dropdown in `settingsTab.ts`
   constrains the choices, but the type system doesn't enforce it. This is deliberate —
   new models can be added to the dropdown without touching the interface.

2. **`updateMethod`** has only two values: `always_regenerate` (overwrite every field) and
   `preserve_existing` (skip fields that already have content). Older versions used
   `"force"`, `"update_all"`, `"no-llm"`, and `"empty_only"` — these are migrated at load time.

3. **Prompts are user-editable.** The defaults ask for specific formatting (lowercase tags,
   1–2 sentence descriptions) but users can replace them entirely.

## 4. Plugin Lifecycle — `main.ts`

This is the entry point Obsidian loads:

```bash
cat /Users/markayers/source/mine/obsidian-metadator/src/main.ts
```

```output
import { Plugin } from "obsidian";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { MetadataToolSettingTab } from "./settingsTab";

export function migrateSettings(
  loaded: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!loaded) return loaded;

  if (loaded.updateMethod === "force" || loaded.updateMethod === "update_all") {
    loaded.updateMethod = "always_regenerate";
  } else if (
    loaded.updateMethod === "no-llm" ||
    loaded.updateMethod === "empty_only"
  ) {
    loaded.updateMethod = "preserve_existing";
  }

  if (loaded.anthropicModel === "claude-sonnet-4-5-20250929") {
    loaded.anthropicModel = "claude-sonnet-4-6";
  }

  return loaded;
}

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

  async loadSettings(): Promise<void> {
    const loadedSettings = migrateSettings(await this.loadData());
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

The plugin class is minimal — it loads settings, registers one command, and wires up the
settings tab. All the real work is delegated to `generateMetadata()`.

`migrateSettings()` is a pure function. It mutates in place but that's fine because the
caller (`loadSettings`) always feeds it a fresh object from `this.loadData()` and then
merges the result into a new object with `Object.assign({}, DEFAULT_SETTINGS, ...)`.
The migration covers two historical changes:

- **Update method rename**: `"force"` / `"update_all"` → `"always_regenerate"`,
  `"no-llm"` / `"empty_only"` → `"preserve_existing"`
- **Model name change**: `"claude-sonnet-4-5-20250929"` → `"claude-sonnet-4-6"`

There's no versioning scheme for migrations — each one is a direct value check. This is
simple but means future migrations must avoid collisions with past values.

## 5. Utilities — Token Counting and Truncation

Before we look at the orchestration layer, we need to understand the primitives it depends
on. `utils.ts` contains the token-level operations, the Claude API wrapper, and the
frontmatter writer.

### 5a. Token Splitting

```bash
sed -n "/^export function splitIntoTokens/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export function splitIntoTokens(str: string): string[] {
  const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g;
  const tokens = str.match(regex);
  return tokens || [];
}
```

The regex has four alternations:

| Pattern | Matches |
|---------|---------|
| `[\u4e00-\u9fa5]` | Individual CJK characters |
| `[a-zA-Z0-9]+` | English words (greedily) |
| `[.,!?;，。！？；#]` | Western and CJK punctuation |
| `[\n]` | Newlines |

This is a **word-level tokenizer**, not a Claude BPE tokenizer. The README warns that
counts may differ 10–15% from Claude's actual token count. That's an acceptable trade-off:
the goal is approximate truncation, not billing prediction.

**Concern:** Whitespace between words is silently dropped. The companion `joinTokens`
must reconstruct spacing heuristically.

### 5b. Token Joining

```bash
sed -n "/^export function joinTokens/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
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

The heuristic: CJK characters and punctuation get no preceding space; English words get
a space unless they follow a newline. It's lossy — extra whitespace and indentation from
the original text is gone — but for feeding content into an LLM prompt, that's fine.

### 5c. Three Truncation Strategies

```bash
sed -n "/^export function truncateHeadOnly/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export function truncateHeadOnly(tokens: string[], limit: number): string {
  return `${joinTokens(tokens.slice(0, limit))}...`;
}
```

```bash
sed -n "/^export function truncateHeadTail/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export function truncateHeadTail(tokens: string[], limit: number): string {
  const left = Math.max(1, Math.floor(limit * 0.8));
  const right = Math.max(0, limit - left);
  const leftTokens = tokens.slice(0, left);
  const rightTokens = right > 0 ? tokens.slice(-right) : [];
  return `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
}
```

```bash
sed -n "/^export function truncateHeading/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export function truncateHeading(
  contentStr: string,
  tokens: string[],
  limit: number,
): string {
  let lines = contentStr.split("\n");
  lines = lines.filter((line) => line.trim() !== "");

  const newLines: string[] = [];
  let captureNextParagraph = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      newLines.push(line);
      captureNextParagraph = true;
    } else if (captureNextParagraph && line.trim() !== "") {
      const lineTokens = splitIntoTokens(line);
      newLines.push(`${joinTokens(lineTokens.slice(0, 30))}...`);
      captureNextParagraph = false;
    }
  }
  let result = newLines.join("\n");
  const totalTokens = splitIntoTokens(result);
  if (totalTokens.length > limit) {
    result = joinTokens(totalTokens.slice(0, limit));
  } else {
    const remainingTokens = limit - totalTokens.length;
    const head = `${joinTokens(tokens.slice(0, remainingTokens))}...`;
    result = `Outline: \n${result}\n\nBody: ${head}`;
  }
  return result;
}
```

**`head_only`** — Take the first N tokens, append `"..."`. Simple and predictable.

**`head_tail`** — Take 80% from the start, 20% from the end, separated by `\n...\n`.
The idea is that conclusions and summaries often appear at the end of a document. The
`Math.max(1, ...)` / `Math.max(0, ...)` guards prevent zero-length slices.

**`heading`** — The most complex strategy. It:
1. Extracts every line starting with `#` (markdown headings)
2. Captures the first non-empty paragraph after each heading, truncated to 30 tokens
3. If the outline itself exceeds the limit, truncates the outline
4. Otherwise, fills remaining budget with body content from the start

This gives Claude a structural overview of the document before raw content. The 30-token
paragraph cap is hardcoded.

**Concern:** `truncateHeadOnly` always appends `"..."` even if the content fits within
the limit. The caller (`getContent`) gates on `tokens.length > limit` before calling,
so this doesn't fire for short content, but the function itself doesn't check.

### 5d. The Claude API Wrapper

```bash
sed -n "/^export async function callClaude/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export async function callClaude(
  prompt: string,
  settings: MetadataToolSettings,
): Promise<string> {
  const notice = new Notice("Generating metadata...", 0);

  // Safe in Obsidian's Electron renderer — no browser security concerns apply
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  try {
    const message = await anthropic.messages.create({
      model: settings.anthropicModel,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    notice.hide();

    if (message.content.length > 0 && message.content[0].type === "text") {
      return message.content[0].text;
    }

    throw new Error("No text content in response");
  } catch (error) {
    notice.hide();

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
      new Notice("An unknown API error occurred", 8000);
    }

    console.error("Claude API error:", error);
    throw error;
  }
}
```

Key details:

- **`dangerouslyAllowBrowser: true`** is required because Obsidian plugins run in an
  Electron renderer process. The Anthropic SDK raises an error without this flag in
  browser-like environments. The comment explains why it's safe here.
- **`max_tokens: 2048`** is hardcoded — not user-configurable. Since the response is
  just a small JSON object with tags, description, and title, 2048 is generous.
- **Error handling** differentiates four API error classes plus a catch-all. Each gets
  a user-facing `Notice` with 8 seconds of visibility, plus console logging.
- The indefinite "Generating metadata..." notice (duration `0`) is hidden in both the
  success and error paths.

**Concern:** The catch block re-throws *every* error after showing a notice. This means
the caller (`addMetadataWithClaude`) must also handle the throw. It does — but this
creates a double-notice pattern where both `callClaude` and `generateMetadata` may show
error notices for the same failure.

### 5e. Content Extraction

```bash
sed -n "/^export async function getContent/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
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

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit && limit > 0) {
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

This is the dispatch point for truncation. It reads the full file, tokenizes it, and
applies truncation only when the token count exceeds the limit *and* the limit is
positive. If the file is short enough, the original content passes through untouched —
including any YAML frontmatter.

### 5f. Frontmatter Updates

```bash
sed -n "/^export async function updateFrontMatter/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.ts
```

```output
export async function updateFrontMatter(
  file: TFile,
  app: App,
  key: string,
  value: string | boolean | string[],
  method: "append" | "update" | "keep",
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (method === "append") {
      if (Array.isArray(value)) {
        const existing = frontmatter[key];
        const base = Array.isArray(existing)
          ? existing
          : existing != null
            ? [String(existing)]
            : [];
        frontmatter[key] = Array.from(new Set(base.concat(value)));
      }
    } else if (method === "update") {
      frontmatter[key] = value;
    } else if (frontmatter[key] === undefined) {
      frontmatter[key] = value;
    }
  });
}
```

This wraps Obsidian's `processFrontMatter()` API, which handles YAML parsing and
serialization internally. Three strategies:

- **`append`** — Merge arrays with deduplication via `Set`. If the existing value is a
  string (e.g., someone wrote `tags: machine-learning` instead of an array), it gets
  normalized to `[string]` before merging.
- **`update`** — Unconditional overwrite.
- **`keep`** — Only writes if the field is `undefined` (not just empty — `""` counts as
  having a value).

**Concern:** The `append` path silently does nothing when `value` is not an array. This
is safe in practice (only tags use `append`, and `parseTags` always returns `string[]`)
but the function signature accepts `string | boolean | string[]` for all methods.

## 6. Metadata Orchestration — `metadata.ts`

This is the heart of the plugin. Let's walk through it top to bottom.

### 6a. Building the Prompt

```bash
sed -n "/^export function buildPrompt/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts
```

```output
export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): string {
  const promptParts = [
    "I need to generate metadata for the following article. Requirements:",
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
    promptParts.push("", `3. Title: ${settings.titlePrompt}`);
    jsonFields.push('"title": "article title"');
  }

  promptParts.push(
    "",
    "Please return in the following JSON format:",
    `{`,
    `    ${jsonFields.join(",\n    ")}`,
    `}`,
    "",
    "Article content:",
    "",
    contentStr,
  );

  return promptParts.join("\n");
}
```

The prompt is constructed by joining string arrays rather than a template literal —
this makes the conditional title section clean. The JSON template shown to Claude uses
a simple format with comma-separated tags in a single string, not a JSON array. This is
a deliberate choice: `parseTags` splits the comma-separated string later.

### 6b. Response Parsing

```bash
sed -n "/^export function isValidMetadataResponse/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts
```

```output
```

```bash
grep -n "isValidMetadataResponse\|parseMetadataResponse\|parseTags\|stripSurroundingQuotes\|resolveUpdateMethod" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts | head -20
```

```output
48:function isValidMetadataResponse(obj: unknown): obj is MetadataResponse {
58:export function parseMetadataResponse(
67:  return isValidMetadataResponse(parsed) ? parsed : null;
70:export function parseTags(tagsString: string): string[] {
77:export function stripSurroundingQuotes(str: string): string {
88:export function resolveUpdateMethod(
195:    metadata = parseMetadataResponse(response) ?? {};
208:    const tags = parseTags(metadata.tags);
228:    const method = resolveUpdateMethod(
253:    const title = stripSurroundingQuotes(metadata.title);
254:    const method = resolveUpdateMethod(
```

```bash
sed -n "48,100p" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts
```

```output
function isValidMetadataResponse(obj: unknown): obj is MetadataResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    (r.tags === undefined || typeof r.tags === "string") &&
    (r.description === undefined || typeof r.description === "string") &&
    (r.title === undefined || typeof r.title === "string")
  );
}

export function parseMetadataResponse(
  response: string,
): MetadataResponse | null {
  const stripped = response.replace(/```(?:json)?\n?/g, "");
  const jsonMatch = stripped.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return null;
  }
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  return isValidMetadataResponse(parsed) ? parsed : null;
}

export function parseTags(tagsString: string): string[] {
  return tagsString
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export function stripSurroundingQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.substring(1, trimmed.length - 1);
  }
  return trimmed;
}

export function resolveUpdateMethod(
  force: boolean,
  currentValue: unknown,
): "update" | "keep" {
  if (force) return "update";
  if (
    !currentValue ||
    (typeof currentValue === "string" && currentValue.trim() === "")
  ) {
    return "update";
  }
  return "keep";
}
```

Five cooperating functions:

1. **`isValidMetadataResponse`** — A type guard. All three fields are optional but must be
   strings if present. This rejects responses where Claude returns tags as an array
   instead of a comma-separated string.

2. **`parseMetadataResponse`** — Strips code fences (```json), then uses the **greedy**
   regex `/{[\s\S]*}/` to extract JSON. Greedy is intentional: if Claude wraps the JSON
   in commentary, this grabs from the first `{` to the last `}`. For a single flat object,
   that's correct.

   **Concern:** `JSON.parse` can throw `SyntaxError` and this function doesn't catch it.
   The caller (`addMetadataWithClaude`) has a catch block, but the function's return type
   (`MetadataResponse | null`) suggests it should return `null` on failure, not throw.
   This is tracked as [issue #46](https://github.com/philoserf/obsidian-metadator/issues/46).

3. **`parseTags`** — Splits comma-separated tags, trims, and filters empties.

4. **`stripSurroundingQuotes`** — Claude sometimes wraps values in quotes. This peels
   matching quotes (double or single) off the outside.

5. **`resolveUpdateMethod`** — The decision function for whether to overwrite a field.
   `force=true` (from `always_regenerate` mode) always updates. Otherwise, it updates
   only if the current value is falsy or a whitespace-only string.

   **Concern:** The empty-value check is inconsistent with how `needsMetadata` checks
   the same fields earlier in the flow. `resolveUpdateMethod` checks for whitespace-only
   strings; `needsMetadata` checks `?.length === 0` for tags (which wouldn't catch
   `"  "`). This is tracked as [issue #45](https://github.com/philoserf/obsidian-metadator/issues/45).

### 6c. The Main Orchestrator

```bash
sed -n "/^export async function generateMetadata/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts
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

  // Check if API key is configured
  if (!settings.anthropicApiKey || settings.anthropicApiKey === "") {
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
    !frontMatter[settings.tagsFieldName] ||
    frontMatter[settings.tagsFieldName]?.length === 0 ||
    !frontMatter[settings.descriptionFieldName] ||
    frontMatter[settings.descriptionFieldName]?.trim() === "" ||
    (settings.enableTitle &&
      (!frontMatter[settings.titleFieldName] ||
        frontMatter[settings.titleFieldName]?.trim() === "")) ||
    updateAll;

  if (needsMetadata) {
    try {
      const hasChanges = await addMetadataWithClaude(
        file,
        app,
        settings,
        frontMatter,
        updateAll,
      );
      if (hasChanges) {
        new Notice("Metadata updated successfully");
      }
    } catch {
      // Error already logged and shown to user by callClaude
    }
  }
}
```

The entry point performs three layers of validation:

1. **File existence** — Is a file open?
2. **File type** — Is it markdown?
3. **API key** — Is the key configured?

Then it reads the metadata cache (Obsidian's in-memory frontmatter index) and decides
whether an API call is needed at all. The `needsMetadata` check is a big OR expression:
call Claude if *any* field is missing/empty, or if `always_regenerate` mode is on.

**Concern:** The `needsMetadata` check uses `?.length === 0` for tags and `?.trim() === ""`
for description/title. These are different emptiness tests:
- `?.length === 0` catches empty arrays `[]` and empty strings `""`, but not `"  "` or `null`
- `?.trim() === ""` catches whitespace-only strings but not arrays

This inconsistency is noted in [issue #45](https://github.com/philoserf/obsidian-metadator/issues/45).

The catch block is empty because `callClaude` already logs and shows notices. But it also
means non-Claude errors (e.g., from `parseMetadataResponse` or `updateFrontMatter`) are
silently swallowed. This is tracked as [issue #46](https://github.com/philoserf/obsidian-metadator/issues/46).

### 6d. The Internal Worker

```bash
sed -n "/^async function addMetadataWithClaude/,/^}/p" /Users/markayers/source/mine/obsidian-metadator/src/metadata.ts
```

```output
async function addMetadataWithClaude(
  file: TFile,
  app: App,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  force: boolean = false,
): Promise<boolean> {
  let contentStr = "";
  if (settings.truncateContent) {
    contentStr = await getContent(
      app,
      file,
      settings.maxTokens,
      settings.truncateMethod,
    );
  } else {
    contentStr = await getContent(app, file, -1, "head_only");
  }

  const prompt = buildPrompt(contentStr, settings);

  let response: string;
  try {
    response = await callClaude(prompt, settings);
  } catch (error) {
    console.error("Error calling Claude:", error);
    return false;
  }

  if (!response) {
    return false;
  }

  let metadata: MetadataResponse = {};
  try {
    metadata = parseMetadataResponse(response) ?? {};
  } catch (error) {
    new Notice(
      `Error parsing response: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Parse error:", error);
    return false;
  }

  let hasChanges = false;

  // Update tags
  if (metadata.tags) {
    const tags = parseTags(metadata.tags);
    try {
      await updateFrontMatter(
        file,
        app,
        settings.tagsFieldName,
        tags,
        "append",
      );
      hasChanges = true;
    } catch (error) {
      new Notice(
        `Failed to write tags: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (tags):", error);
    }
  }

  // Update description
  if (metadata.description) {
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.descriptionFieldName],
    );
    try {
      await updateFrontMatter(
        file,
        app,
        settings.descriptionFieldName,
        metadata.description,
        method,
      );
      if (method === "update") {
        hasChanges = true;
      }
    } catch (error) {
      new Notice(
        `Failed to write description: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (description):", error);
    }
  }

  // Update title
  if (settings.enableTitle && metadata.title) {
    const title = stripSurroundingQuotes(metadata.title);
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.titleFieldName],
    );
    try {
      await updateFrontMatter(
        file,
        app,
        settings.titleFieldName,
        title,
        method,
      );
      if (method === "update") {
        hasChanges = true;
      }
    } catch (error) {
      new Notice(
        `Failed to write title: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("updateFrontMatter error (title):", error);
    }
  }

  return hasChanges;
}
```

This is where the data flow comes together. Step by step:

1. **Content extraction** — If truncation is enabled, apply the configured method. If
   disabled, pass `limit=-1` which means `getContent` returns the full file (since
   `tokens.length > -1` is always true but `limit > 0` fails, so no truncation).

2. **Prompt building** — Delegate to `buildPrompt`.

3. **API call** — Try `callClaude`. On failure, log and return `false` (the error notice
   was already shown by `callClaude`).

4. **Response parsing** — Try `parseMetadataResponse`. On failure (bad JSON), show a
   notice and return `false`.

5. **Field updates** — Each field (tags, description, title) is updated independently
   with its own try/catch. Tags always use `"append"` (merge + dedup). Description and
   title consult `resolveUpdateMethod` to decide between `"update"` and `"keep"`.

Notice that each `updateFrontMatter` call is `await`ed sequentially. This is critical —
`processFrontMatter` reads and writes the file, and parallel calls on the same file
would race.

The `hasChanges` tracking is approximate: it counts `"update"` methods as changes but
not `"keep"`, and tags always count as changes even if the append was a no-op (all
tags already existed). This is a minor UX imprecision.

## 7. Settings UI — `settingsTab.ts`

The settings panel is the longest file by line count. Let's look at its structure:

```bash
wc -l /Users/markayers/source/mine/obsidian-metadator/src/settingsTab.ts
```

```output
     221 /Users/markayers/source/mine/obsidian-metadator/src/settingsTab.ts
```

```bash
sed -n "1,30p" /Users/markayers/source/mine/obsidian-metadator/src/settingsTab.ts
```

```output
import { type App, PluginSettingTab, Setting } from "obsidian";
import type MetadataToolPlugin from "./main";

export class MetadataToolSettingTab extends PluginSettingTab {
  plugin: MetadataToolPlugin;

  constructor(app: App, plugin: MetadataToolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Anthropic API Settings
    new Setting(containerEl).setName("Anthropic API Settings").setHeading();

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        "Your Anthropic API key. Get one at console.anthropic.com (requires an account with billing enabled)",
      )
      .addText((text) => {
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value;
            await this.plugin.saveSettings();
```

At 221 lines, the settings tab is mostly Obsidian boilerplate: create a `Setting` object,
configure its name, description, and input widget, wire up the `onChange` handler to
mutate `this.plugin.settings` and call `saveSettings()`.

Interesting patterns:

```bash
grep -n "inputEl.type\|disabled\|setDisabled\|\.inputEl" /Users/markayers/source/mine/obsidian-metadator/src/settingsTab.ts
```

```output
32:        text.inputEl.type = "password";
82:            maxTokensSetting.setDisabled(!value);
83:            truncateMethodSetting.setDisabled(!value);
117:    maxTokensSetting.setDisabled(!this.plugin.settings.truncateContent);
118:    truncateMethodSetting.setDisabled(!this.plugin.settings.truncateContent);
145:        text.inputEl.setAttr("rows", "3");
173:        text.inputEl.setAttr("rows", "3");
188:            titleFieldNameSetting.setDisabled(!value);
189:            titlePromptSetting.setDisabled(!value);
215:        text.inputEl.setAttr("rows", "3");
218:    titleFieldNameSetting.setDisabled(!this.plugin.settings.enableTitle);
219:    titlePromptSetting.setDisabled(!this.plugin.settings.enableTitle);
```

- **Password masking** — The API key field uses `inputEl.type = "password"` for visual
  privacy. This is a DOM-level change since Obsidian's `Setting` API doesn't have a
  built-in password input type.

- **Conditional disabling** — When "Truncate Content" is toggled off, the Max Tokens and
  Truncate Method controls are disabled. Same for the title-related fields when "Enable
  Title" is off. The initial disabled state is set after the widget is created, and the
  toggle's `onChange` updates it dynamically.

- **Max Tokens parsing** — The input is a text field parsed with `parseInt`. If parsing
  fails (NaN), it silently falls back to 1000:

```bash
sed -n "/Max Tokens/,/});/p" /Users/markayers/source/mine/obsidian-metadator/src/settingsTab.ts | head -15
```

```output
      .setName("Max Tokens")
      .setDesc("Maximum content length in tokens")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.maxTokens.toString())
          .onChange(async (value) => {
            this.plugin.settings.maxTokens = parseInt(value, 10) || 1000;
            await this.plugin.saveSettings();
          }),
      );

    const truncateMethodSetting = new Setting(containerEl)
      .setName("Truncate Method")
      .setDesc("How to truncate long content")
      .addDropdown((dropdown) =>
```

`parseInt(value, 10) || 1000` means that typing `"abc"`, `"0"`, or `"-5"` all silently
reset to 1000. Non-positive values and garbage input get no user feedback. This is tracked
as [issue #44](https://github.com/philoserf/obsidian-metadator/issues/44).

## 8. Test Coverage

The suite has 76 tests across three files:

```bash
grep -c "it(" /Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts /Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts /Users/markayers/source/mine/obsidian-metadator/src/main.test.ts
```

```output
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:0
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:0
/Users/markayers/source/mine/obsidian-metadator/src/main.test.ts:0
```

```bash
grep -c "test(" /Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts /Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts /Users/markayers/source/mine/obsidian-metadator/src/main.test.ts
```

```output
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:33
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:34
/Users/markayers/source/mine/obsidian-metadator/src/main.test.ts:9
```

```bash
grep "describe(" /Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts /Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts /Users/markayers/source/mine/obsidian-metadator/src/main.test.ts
```

```output
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("splitIntoTokens", () => {
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("joinTokens", () => {
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("truncateHeadOnly", () => {
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("truncateHeadTail", () => {
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("truncateHeading", () => {
/Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts:describe("updateFrontMatter", () => {
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:describe("parseMetadataResponse", () => {
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:describe("parseTags", () => {
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:describe("stripSurroundingQuotes", () => {
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:describe("resolveUpdateMethod", () => {
/Users/markayers/source/mine/obsidian-metadator/src/metadata.test.ts:describe("buildPrompt", () => {
/Users/markayers/source/mine/obsidian-metadator/src/main.test.ts:describe("migrateSettings", () => {
```

76 tests, 12 describe blocks. Coverage hits every exported pure function:

| File | Tests | Covers |
|------|------:|--------|
| `utils.test.ts` | 33 | splitIntoTokens, joinTokens, truncateHeadOnly, truncateHeadTail, truncateHeading, updateFrontMatter |
| `metadata.test.ts` | 34 | parseMetadataResponse, parseTags, stripSurroundingQuotes, resolveUpdateMethod, buildPrompt |
| `main.test.ts` | 9 | migrateSettings |

What's *not* tested: `callClaude` (requires API mocking), `generateMetadata` and
`addMetadataWithClaude` (require full Obsidian `App` mock), and `settingsTab.ts`
(UI rendering). This is a pragmatic boundary — the untested code is thin glue around
APIs that would need extensive mocking.

The `updateFrontMatter` tests use a hand-rolled fake for `processFrontMatter`:

```bash
sed -n "/describe..updateFrontMatter/,/^});/p" /Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts | head -30
```

```output
describe("updateFrontMatter", () => {
  test("keep: preserves an existing value", async () => {
    const { app, fm } = makeApp({ description: "existing" });
    await updateFrontMatter(
      {} as TFile,
      app,
      "description",
      "new value",
      "keep",
    );
    expect(fm.description).toBe("existing");
  });

  test("keep: sets the value when field is absent", async () => {
    const { app, fm } = makeApp({});
    await updateFrontMatter(
      {} as TFile,
      app,
      "description",
      "new value",
      "keep",
    );
    expect(fm.description).toBe("new value");
  });

  test("update: overwrites an existing value", async () => {
    const { app, fm } = makeApp({ description: "old" });
    await updateFrontMatter(
      {} as TFile,
      app,
```

```bash
grep -A 12 "function makeApp" /Users/markayers/source/mine/obsidian-metadator/src/utils.test.ts
```

```output
function makeApp(initial: Record<string, unknown> = {}): {
  app: App;
  fm: Record<string, unknown>;
} {
  const fm = { ...initial };
  const app = {
    fileManager: {
      processFrontMatter: async (
        _file: unknown,
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        fn(fm);
      },
```

The `makeApp` helper creates a fake `App` whose `processFrontMatter` calls the callback
synchronously with a shared mutable object. Tests inspect that object after the call to
verify the mutation. This is a clean test double — it exercises the real logic in
`updateFrontMatter` without needing Obsidian's file I/O.

**Concern:** There's an open issue ([#47](https://github.com/philoserf/obsidian-metadator/issues/47))
about a vacuous assertion in the `truncateHeading` tests — a test that asserts something
trivially true and provides no real coverage.

## 9. Data Flow Summary

Here's the complete path from user action to file change:

```bash
cat <<'HEREDOC'
User runs command (Cmd+P → "Generate metadata for current note")
│
├─ main.ts: MetadataToolPlugin.callback()
│  └─ metadata.ts: generateMetadata(app, settings)
│     ├─ validate: file exists, is .md, API key configured
│     ├─ read frontmatter from metadata cache
│     ├─ check needsMetadata (any field empty OR always_regenerate)
│     │
│     └─ metadata.ts: addMetadataWithClaude(file, app, settings, fm, force)
│        │
│        ├─ utils.ts: getContent(app, file, maxTokens, method)
│        │  ├─ app.vault.read(file)
│        │  ├─ splitIntoTokens(content)
│        │  └─ truncateHeadOnly|HeadTail|Heading(tokens, limit)
│        │
│        ├─ metadata.ts: buildPrompt(content, settings)
│        │
│        ├─ utils.ts: callClaude(prompt, settings)
│        │  └─ anthropic.messages.create({ model, max_tokens, messages })
│        │
│        ├─ metadata.ts: parseMetadataResponse(response)
│        │  ├─ strip code fences
│        │  ├─ regex extract JSON: /{[\s\S]*}/
│        │  ├─ JSON.parse
│        │  └─ isValidMetadataResponse (type guard)
│        │
│        └─ for each field:
│           ├─ tags: parseTags → updateFrontMatter(append, dedup)
│           ├─ description: resolveUpdateMethod → updateFrontMatter
│           └─ title: stripSurroundingQuotes → resolveUpdateMethod → updateFrontMatter
│
└─ Notice: "Metadata updated successfully"
HEREDOC
```

```output
User runs command (Cmd+P → "Generate metadata for current note")
│
├─ main.ts: MetadataToolPlugin.callback()
│  └─ metadata.ts: generateMetadata(app, settings)
│     ├─ validate: file exists, is .md, API key configured
│     ├─ read frontmatter from metadata cache
│     ├─ check needsMetadata (any field empty OR always_regenerate)
│     │
│     └─ metadata.ts: addMetadataWithClaude(file, app, settings, fm, force)
│        │
│        ├─ utils.ts: getContent(app, file, maxTokens, method)
│        │  ├─ app.vault.read(file)
│        │  ├─ splitIntoTokens(content)
│        │  └─ truncateHeadOnly|HeadTail|Heading(tokens, limit)
│        │
│        ├─ metadata.ts: buildPrompt(content, settings)
│        │
│        ├─ utils.ts: callClaude(prompt, settings)
│        │  └─ anthropic.messages.create({ model, max_tokens, messages })
│        │
│        ├─ metadata.ts: parseMetadataResponse(response)
│        │  ├─ strip code fences
│        │  ├─ regex extract JSON: /{[\s\S]*}/
│        │  ├─ JSON.parse
│        │  └─ isValidMetadataResponse (type guard)
│        │
│        └─ for each field:
│           ├─ tags: parseTags → updateFrontMatter(append, dedup)
│           ├─ description: resolveUpdateMethod → updateFrontMatter
│           └─ title: stripSurroundingQuotes → resolveUpdateMethod → updateFrontMatter
│
└─ Notice: "Metadata updated successfully"
```

## 10. Dependencies

The plugin ships one runtime dependency and five dev dependencies:

```bash
sed -n "/\"dependencies\"/,/\"devDependencies\"/p" /Users/markayers/source/mine/obsidian-metadator/package.json | head -4
```

```output
  "dependencies": {
    "@anthropic-ai/sdk": "^0.78.0"
  }
}
```

```bash
sed -n "/\"devDependencies\"/,/^  }/p" /Users/markayers/source/mine/obsidian-metadator/package.json
```

```output
  "devDependencies": {
    "@biomejs/biome": "^2.4.4",
    "@types/bun": "^1.3.9",
    "@types/node": "25.3.2",
    "obsidian": "1.12.3",
    "typescript": "5.9.3"
  },
```

The only runtime dependency is `@anthropic-ai/sdk`, which Bun bundles into `main.js`.
The `obsidian` package is types-only — the real module is provided by the Obsidian host
at runtime and marked as `external` in the build config.

Note: `@types/node` and `obsidian` are pinned to exact versions while the others use
caret ranges. This is typical for type packages where minor version bumps can introduce
breaking type changes.

## 11. Build Output

```bash
wc -c /Users/markayers/source/mine/obsidian-metadator/main.js | awk '{printf "%d bytes (%.0f KB)\n", $1, $1/1024}'
```

```output
85338 bytes (83 KB)
```

```bash
head -3 /Users/markayers/source/mine/obsidian-metadator/main.js
```

```output
var{defineProperty:R0,getOwnPropertyNames:q2,getOwnPropertyDescriptor:O2}=Object,H2=Object.prototype.hasOwnProperty;var O4=new WeakMap,M2=(w)=>{var X=O4.get(w),Z;if(X)return X;if(X=R0({},"__esModule",{value:!0}),w&&typeof w==="object"||typeof w==="function")q2(w).map(($)=>!H2.call(X,$)&&R0(X,$,{get:()=>w[$],enumerable:!(Z=O2(w,$))||Z.enumerable}));return O4.set(w,X),X};var D2=(w,X)=>{for(var Z in X)R0(w,Z,{get:X[Z],enumerable:!0,configurable:!0,set:($)=>X[Z]=()=>$})};var C5={};D2(C5,{migrateSettings:()=>U2,default:()=>x4});module.exports=M2(C5);var C2=require("obsidian");var m=require("obsidian");function V(w,X,Z,$,z){if($==="m")throw TypeError("Private method is not writable");if($==="a"&&!z)throw TypeError("Private accessor was defined without a setter");if(typeof X==="function"?w!==X||!z:!X.has(w))throw TypeError("Cannot write private member to an object whose class did not declare it");return $==="a"?z.call(w,Z):z?z.value=Z:X.set(w,Z),Z}function Y(w,X,Z,$){if(Z==="a"&&!$)throw TypeError("Private accessor was defined without a getter");if(typeof X==="function"?w!==X||!$:!X.has(w))throw TypeError("Cannot read private member from an object whose class did not declare it");return Z==="m"?$:Z==="a"?$.call(w):$?$.value:X.get(w)}var k0=function(){let{crypto:w}=globalThis;if(w?.randomUUID)return k0=w.randomUUID.bind(w),w.randomUUID();let X=new Uint8Array(1),Z=w?()=>w.getRandomValues(X)[0]:()=>Math.random()*255&255;return"10000000-1000-4000-8000-100000000000".replace(/[018]/g,($)=>(+$^Z()&15>>+$/4).toString(16))};function g(w){return typeof w==="object"&&w!==null&&(("name"in w)&&w.name==="AbortError"||("message"in w)&&String(w.message).includes("FetchRequestCanceledException"))}var qw=(w)=>{if(w instanceof Error)return w;if(typeof w==="object"&&w!==null){try{if(Object.prototype.toString.call(w)==="[object Error]"){let X=Error(w.message,w.cause?{cause:w.cause}:{});if(w.stack)X.stack=w.stack;if(w.cause&&!X.cause)X.cause=w.cause;if(w.name)X.name=w.name;return X}}catch{}try{return Error(JSON.stringify(w))}catch{}}return Error(w)};class N extends Error{}class T extends N{constructor(w,X,Z,$){super(`${T.makeMessage(w,X,Z)}`);this.status=w,this.headers=$,this.requestID=$?.get("request-id"),this.error=X}static makeMessage(w,X,Z){let $=X?.message?typeof X.message==="string"?X.message:JSON.stringify(X.message):X?JSON.stringify(X):Z;if(w&&$)return`${w} ${$}`;if(w)return`${w} status code (no body)`;if($)return $;return"(no status code or body)"}static generate(w,X,Z,$){if(!w||!$)return new t({message:Z,cause:qw(X)});let z=X;if(w===400)return new Hw(w,z,Z,$);if(w===401)return new Mw(w,z,Z,$);if(w===403)return new Dw(w,z,Z,$);if(w===404)return new Tw(w,z,Z,$);if(w===409)return new Aw(w,z,Z,$);if(w===422)return new Ew(w,z,Z,$);if(w===429)return new Sw(w,z,Z,$);if(w>=500)return new Fw(w,z,Z,$);return new T(w,z,Z,$)}}class F extends T{constructor({message:w}={}){super(void 0,void 0,w||"Request was aborted.",void 0)}}class t extends T{constructor({message:w,cause:X}){super(void 0,void 0,w||"Connection error.",void 0);if(X)this.cause=X}}class Ow extends t{constructor({message:w}={}){super({message:w??"Request timed out."})}}class Hw extends T{}class Mw extends T{}class Dw extends T{}class Tw extends T{}class Aw extends T{}class Ew extends T{}class Sw extends T{}class Fw extends T{}var A2=/^[a-z][a-z0-9+.-]*:/i,H4=(w)=>{return A2.test(w)},h0=(w)=>(h0=Array.isArray,h0(w)),b0=h0;function W0(w){if(typeof w!=="object")return{};return w??{}}function M4(w){if(!w)return!0;for(let X in w)return!1;return!0}function D4(w,X){return Object.prototype.hasOwnProperty.call(w,X)}var T4=(w,X)=>{if(typeof X!=="number"||!Number.isInteger(X))throw new N(`${w} must be an integer`);if(X<0)throw new N(`${w} must be a positive integer`);return X};var Y0=(w)=>{try{return JSON.parse(w)}catch(X){return}};var A4=(w)=>new Promise((X)=>setTimeout(X,w));var u="0.78.0";var I4=()=>{return typeof window<"u"&&typeof window.document<"u"&&typeof navigator<"u"};function E2(){if(typeof Deno<"u"&&Deno.build!=null)return"deno";if(typeof EdgeRuntime<"u")return"edge";if(Object.prototype.toString.call(typeof globalThis.process<"u"?globalThis.process:0)==="[object process]")return"node";return"unknown"}var S2=()=>{let w=E2();if(w==="deno")return{"X-Stainless-Lang":"js","X-Stainless-Package-Version":u,"X-Stainless-OS":S4(Deno.build.os),"X-Stainless-Arch":E4(Deno.build.arch),"X-Stainless-Runtime":"deno","X-Stainless-Runtime-Version":typeof Deno.version==="string"?Deno.version:Deno.version?.deno??"unknown"};if(typeof EdgeRuntime<"u")return{"X-Stainless-Lang":"js","X-Stainless-Package-Version":u,"X-Stainless-OS":"Unknown","X-Stainless-Arch":`other:${EdgeRuntime}`,"X-Stainless-Runtime":"edge","X-Stainless-Runtime-Version":globalThis.process.version};if(w==="node")return{"X-Stainless-Lang":"js","X-Stainless-Package-Version":u,"X-Stainless-OS":S4(globalThis.process.platform??"unknown"),"X-Stainless-Arch":E4(globalThis.process.arch??"unknown"),"X-Stainless-Runtime":"node","X-Stainless-Runtime-Version":globalThis.process.version??"unknown"};let X=F2();if(X)return{"X-Stainless-Lang":"js","X-Stainless-Package-Version":u,"X-Stainless-OS":"Unknown","X-Stainless-Arch":"unknown","X-Stainless-Runtime":`browser:${X.browser}`,"X-Stainless-Runtime-Version":X.version};return{"X-Stainless-Lang":"js","X-Stainless-Package-Version":u,"X-Stainless-OS":"Unknown","X-Stainless-Arch":"unknown","X-Stainless-Runtime":"unknown","X-Stainless-Runtime-Version":"unknown"}};function F2(){if(typeof navigator>"u"||!navigator)return null;let w=[{key:"edge",pattern:/Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/},{key:"ie",pattern:/MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/},{key:"ie",pattern:/Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/},{key:"chrome",pattern:/Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/},{key:"firefox",pattern:/Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/},{key:"safari",pattern:/(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/}];for(let{key:X,pattern:Z}of w){let $=Z.exec(navigator.userAgent);if($){let z=$[1]||0,W=$[2]||0,K=$[3]||0;return{browser:X,version:`${z}.${W}.${K}`}}}return null}var E4=(w)=>{if(w==="x32")return"x32";if(w==="x86_64"||w==="x64")return"x64";if(w==="arm")return"arm";if(w==="aarch64"||w==="arm64")return"arm64";if(w)return`other:${w}`;return"unknown"},S4=(w)=>{if(w=w.toLowerCase(),w.includes("ios"))return"iOS";if(w==="android")return"Android";if(w==="darwin")return"MacOS";if(w==="win32")return"Windows";if(w==="freebsd")return"FreeBSD";if(w==="openbsd")return"OpenBSD";if(w==="linux")return"Linux";if(w)return`Other:${w}`;return"Unknown"},F4,L4=()=>{return F4??(F4=S2())};function j4(){if(typeof fetch<"u")return fetch;throw Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`")}function g0(...w){let X=globalThis.ReadableStream;if(typeof X>"u")throw Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");return new X(...w)}function K0(w){let X=Symbol.asyncIterator in w?w[Symbol.asyncIterator]():w[Symbol.iterator]();return g0({start(){},async pull(Z){let{done:$,value:z}=await X.next();if($)Z.close();else Z.enqueue(z)},async cancel(){await X.return?.()}})}function Iw(w){if(w[Symbol.asyncIterator])return w;let X=w.getReader();return{async next(){try{let Z=await X.read();if(Z?.done)X.releaseLock();return Z}catch(Z){throw X.releaseLock(),Z}},async return(){let Z=X.cancel();return X.releaseLock(),await Z,{done:!0,value:void 0}},[Symbol.asyncIterator](){return this}}}async function B4(w){if(w===null||typeof w!=="object")return;if(w[Symbol.asyncIterator]){await w[Symbol.asyncIterator]().return?.();return}let X=w.getReader(),Z=X.cancel();X.releaseLock(),await Z}var P4=({headers:w,body:X})=>{return{bodyHeaders:{"content-type":"application/json"},body:JSON.stringify(X)}};function R4(w){let X=0;for(let z of w)X+=z.length;let Z=new Uint8Array(X),$=0;for(let z of w)Z.set(z,$),$+=z.length;return Z}var y4;function Lw(w){let X;return(y4??(X=new globalThis.TextEncoder,y4=X.encode.bind(X)))(w)}var f4;function _0(w){let X;return(f4??(X=new globalThis.TextDecoder,f4=X.decode.bind(X)))(w)}var I,L;class p{constructor(){I.set(this,void 0),L.set(this,void 0),V(this,I,new Uint8Array,"f"),V(this,L,null,"f")}decode(w){if(w==null)return[];let X=w instanceof ArrayBuffer?new Uint8Array(w):typeof w==="string"?Lw(w):w;V(this,I,R4([Y(this,I,"f"),X]),"f");let Z=[],$;while(($=j2(Y(this,I,"f"),Y(this,L,"f")))!=null){if($.carriage&&Y(this,L,"f")==null){V(this,L,$.index,"f");continue}if(Y(this,L,"f")!=null&&($.index!==Y(this,L,"f")+1||$.carriage)){Z.push(_0(Y(this,I,"f").subarray(0,Y(this,L,"f")-1))),V(this,I,Y(this,I,"f").subarray(Y(this,L,"f")),"f"),V(this,L,null,"f");continue}let z=Y(this,L,"f")!==null?$.preceding-1:$.preceding,W=_0(Y(this,I,"f").subarray(0,z));Z.push(W),V(this,I,Y(this,I,"f").subarray($.index),"f"),V(this,L,null,"f")}return Z}flush(){if(!Y(this,I,"f").length)return[];return this.decode(`
`)}}I=new WeakMap,L=new WeakMap;p.NEWLINE_CHARS=new Set([`
`,"\r"]);p.NEWLINE_REGEXP=/\r\n|[\n\r]/g;function j2(w,X){for(let z=X??0;z<w.length;z++){if(w[z]===10)return{preceding:z,index:z+1,carriage:!1};if(w[z]===13)return{preceding:z,index:z+1,carriage:!0}}return null}function k4(w){for(let $=0;$<w.length-1;$++){if(w[$]===10&&w[$+1]===10)return $+2;if(w[$]===13&&w[$+1]===13)return $+2;if(w[$]===13&&w[$+1]===10&&$+3<w.length&&w[$+2]===13&&w[$+3]===10)return $+4}return-1}var V0={off:0,error:200,warn:300,info:400,debug:500},d0=(w,X,Z)=>{if(!w)return;if(D4(V0,w))return w;S(Z).warn(`${X} was set to ${JSON.stringify(w)}, expected one of ${JSON.stringify(Object.keys(V0))}`);return};function jw(){}function J0(w,X,Z){if(!X||V0[w]>V0[Z])return jw;else return X[w].bind(X)}var B2={error:jw,warn:jw,info:jw,debug:jw},h4=new WeakMap;function S(w){let X=w.logger,Z=w.logLevel??"off";if(!X)return B2;let $=h4.get(X);if($&&$[0]===Z)return $[1];let z={error:J0("error",X,Z),warn:J0("warn",X,Z),info:J0("info",X,Z),debug:J0("debug",X,Z)};return h4.set(X,[Z,z]),z}var _=(w)=>{if(w.options)w.options={...w.options},delete w.options.headers;if(w.headers)w.headers=Object.fromEntries((w.headers instanceof Headers?[...w.headers]:Object.entries(w.headers)).map(([X,Z])=>[X,X.toLowerCase()==="x-api-key"||X.toLowerCase()==="authorization"||X.toLowerCase()==="cookie"||X.toLowerCase()==="set-cookie"?"***":Z]));if("retryOfRequestLogID"in w){if(w.retryOfRequestLogID)w.retryOf=w.retryOfRequestLogID;delete w.retryOfRequestLogID}return w};var Bw;class j{constructor(w,X,Z){this.iterator=w,Bw.set(this,void 0),this.controller=X,V(this,Bw,Z,"f")}static fromSSEResponse(w,X,Z){let $=!1,z=Z?S(Z):console;async function*W(){if($)throw new N("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");$=!0;let K=!1;try{for await(let J of P2(w,X)){if(J.event==="completion")try{yield JSON.parse(J.data)}catch(Q){throw z.error("Could not parse message into JSON:",J.data),z.error("From chunk:",J.raw),Q}if(J.event==="message_start"||J.event==="message_delta"||J.event==="message_stop"||J.event==="content_block_start"||J.event==="content_block_delta"||J.event==="content_block_stop")try{yield JSON.parse(J.data)}catch(Q){throw z.error("Could not parse message into JSON:",J.data),z.error("From chunk:",J.raw),Q}if(J.event==="ping")continue;if(J.event==="error")throw new T(void 0,Y0(J.data)??J.data,void 0,w.headers)}K=!0}catch(J){if(g(J))return;throw J}finally{if(!K)X.abort()}}return new j(W,X,Z)}static fromReadableStream(w,X,Z){let $=!1;async function*z(){let K=new p,J=Iw(w);for await(let Q of J)for(let U of K.decode(Q))yield U;for(let Q of K.flush())yield Q}async function*W(){if($)throw new N("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");$=!0;let K=!1;try{for await(let J of z()){if(K)continue;if(J)yield JSON.parse(J)}K=!0}catch(J){if(g(J))return;throw J}finally{if(!K)X.abort()}}return new j(W,X,Z)}[(Bw=new WeakMap,Symbol.asyncIterator)](){return this.iterator()}tee(){let w=[],X=[],Z=this.iterator(),$=(z)=>{return{next:()=>{if(z.length===0){let W=Z.next();w.push(W),X.push(W)}return z.shift()}}};return[new j(()=>$(w),this.controller,Y(this,Bw,"f")),new j(()=>$(X),this.controller,Y(this,Bw,"f"))]}toReadableStream(){let w=this,X;return g0({async start(){X=w[Symbol.asyncIterator]()},async pull(Z){try{let{value:$,done:z}=await X.next();if(z)return Z.close();let W=Lw(JSON.stringify($)+`
```

The minified output is ~83 KB. Most of that is the bundled Anthropic SDK. The plugin's
own code is a small fraction — the SDK brings HTTP handling, streaming, error types, and
runtime detection.

`main.js` is committed to the repository because Obsidian's plugin distribution model
requires the built artifact in the repo. Users install plugins by downloading release
assets, which are created from the committed `main.js` and `manifest.json`.

## 12. Obsidian Community Standards

How well does Metadator follow the
[Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)?

```bash
cat /Users/markayers/source/mine/obsidian-metadator/manifest.json
```

```output
{
  "id": "metadator",
  "name": "Metadator",
  "version": "1.1.0",
  "minAppVersion": "1.4.0",
  "description": "Automatically generate metadata for your notes using AI",
  "author": "Mark Ayers",
  "authorUrl": "https://github.com/philoserf",
  "isDesktopOnly": false
}
```

**What it gets right:**

- **`manifest.json`** has all required fields (`id`, `name`, `version`, `minAppVersion`,
  `description`, `author`, `authorUrl`, `isDesktopOnly`)
- Description is vendor-neutral ("using AI" not "using Claude")
- Uses `processFrontMatter` for YAML changes (the recommended Obsidian API)
- Plugin registers a single command — clean command palette integration
- Settings tab follows Obsidian UI conventions (headings, toggles, dropdowns)
- `onunload` is defined (even if empty)
- No `eval()`, no dynamic `require()`
- `isDesktopOnly: false` — though mobile users would need to provide an API key

**Things to watch:**

- **`dangerouslyAllowBrowser: true`** — Necessary but flagged by the SDK. The comment
  explains the rationale. Plugin reviewers may ask about this.
- **Bundle size** — 83 KB is reasonable for a plugin with an API SDK dependency, but
  it's on the larger side for a metadata-only tool. Most of that is the Anthropic SDK.
- **API key storage** — Keys are stored in Obsidian's plugin data (`.obsidian/plugins/
  metadator/data.json`). This is standard practice for Obsidian plugins but it's
  unencrypted JSON on disk. The password-masked input field provides visual privacy
  but not security.
- **No rate limiting** — Users can spam the command and incur API costs. There's no
  debounce, cooldown, or confirmation dialog.

## 13. Open Issues

```bash
cat <<'HEREDOC'
#44  bug: silent fallback on invalid maxTokens input
     parseInt("abc") || 1000 silently resets — no user feedback

#45  bug: needsMetadata has inconsistent empty-value checks across fields
     tags use ?.length === 0; description/title use ?.trim() === ""

#46  bug: catch block in generateMetadata silently swallows non-Claude errors
     parseMetadataResponse throws SyntaxError instead of returning null

#47  test: vacuous assertion in truncateHeading test provides no coverage
     Test asserts something trivially true

#48  chore: biome.json schema pins version instead of using latest
     Schema URL should track latest, not a specific version
HEREDOC
```

```output
#44  bug: silent fallback on invalid maxTokens input
     parseInt("abc") || 1000 silently resets — no user feedback

#45  bug: needsMetadata has inconsistent empty-value checks across fields
     tags use ?.length === 0; description/title use ?.trim() === ""

#46  bug: catch block in generateMetadata silently swallows non-Claude errors
     parseMetadataResponse throws SyntaxError instead of returning null

#47  test: vacuous assertion in truncateHeading test provides no coverage
     Test asserts something trivially true

#48  chore: biome.json schema pins version instead of using latest
     Schema URL should track latest, not a specific version
```

These are all minor. The two bugs (#44, #45) affect edge cases in the settings UI and
frontmatter checking respectively. Issue #46 is a design decision about error
propagation. None affect the happy path.

## 14. Summary

Metadator is a well-structured, small-scope Obsidian plugin. Its architecture makes the
right trade-offs for its size:

- **Pure function extraction** enables thorough testing without complex mocking
- **Single responsibility per file** keeps navigation easy
- **Sequential frontmatter writes** avoid race conditions
- **User-editable prompts** give flexibility without complexity
- **Approximate tokenization** is honest about its limitations

The main risks are API cost (no rate limiting), silent error swallowing (issue #46), and
the inherent fragility of regex-based JSON extraction from LLM output. For a personal
plugin managing note metadata, these are acceptable. For a widely distributed plugin,
they'd want tightening.

