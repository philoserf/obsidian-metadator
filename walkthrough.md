# Metadator Walkthrough

*2026-03-19T18:34:05Z by Showboat 0.6.1*
<!-- showboat-id: 69e9d5fc-1943-4eff-8da0-ef451a9c8a82 -->

## Overview

Metadator is an Obsidian plugin that generates metadata (tags, description, title) for notes using the Anthropic Claude API. The user runs a command, the plugin sends note content to Claude, parses the JSON response, and writes results into YAML frontmatter.

**Key technologies:** TypeScript, Obsidian Plugin API, Anthropic SDK, Bun (build + test)

**Entry point:** `src/main.ts` → `MetadataToolPlugin.onload()` registers the command and settings tab.

**Data flow:**
1. User triggers "Generate metadata for current note"
2. `generateMetadata()` checks which fields need population
3. Content is extracted and optionally truncated
4. `callClaude()` sends the prompt to the Anthropic API
5. Response JSON is parsed with a multi-match strategy
6. `updateFrontMatter()` writes each field via Obsidian's `processFrontMatter()`

## Architecture

Five source modules, each with a single responsibility:

```bash
cat <<'HEREDOC'
src/
├── main.ts          Plugin lifecycle, command registration, settings migration
├── metadata.ts      Prompt building, response parsing, orchestration
├── utils.ts         Claude API call, tokenization, truncation, frontmatter writes
├── settings.ts      Settings interface and defaults
├── settingsTab.ts   Settings UI (PluginSettingTab)
├── main.test.ts     Plugin lifecycle tests
├── metadata.test.ts Metadata generation and parsing tests
├── utils.test.ts    Utility function tests
└── test-preload.ts  Test mocks for Obsidian API
HEREDOC
```

```output
src/
├── main.ts          Plugin lifecycle, command registration, settings migration
├── metadata.ts      Prompt building, response parsing, orchestration
├── utils.ts         Claude API call, tokenization, truncation, frontmatter writes
├── settings.ts      Settings interface and defaults
├── settingsTab.ts   Settings UI (PluginSettingTab)
├── main.test.ts     Plugin lifecycle tests
├── metadata.test.ts Metadata generation and parsing tests
├── utils.test.ts    Utility function tests
└── test-preload.ts  Test mocks for Obsidian API
```

## Settings — `src/settings.ts`

The settings interface defines all configurable options. The plugin defaults to Claude Sonnet 4.6, head-only truncation at 1000 tokens, and preserve-existing update behavior.

```bash
sed -n '1,25p' src/settings.ts
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
```

## Plugin Entry — `src/main.ts`

The plugin extends Obsidian's `Plugin` class. On load it migrates legacy settings values, registers the "Generate metadata" command, and adds the settings tab.

`migrateSettings()` handles two migrations: legacy update method names (`force`→`always_regenerate`, `no-llm`→`preserve_existing`) and deprecated model IDs.

```bash
sed -n '6,29p' src/main.ts
```

```output
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

  if (loaded.anthropicModel === "claude-opus-4-5-20251101") {
    loaded.anthropicModel = "claude-opus-4-6";
  }

  return loaded;
}
```

```bash
sed -n '31,58p' src/main.ts
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

  async loadSettings(): Promise<void> {
    const loadedSettings = migrateSettings(await this.loadData());
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

## Metadata Orchestration — `src/metadata.ts`

### Entry: `generateMetadata()`

The main command handler. Validates preconditions (active file, markdown, API key), then checks whether any frontmatter fields need population. If so, delegates to `addMetadataWithClaude()`.

The `needsMetadata` check uses `isEmptyValue()` for each field and short-circuits if `updateMethod` is `always_regenerate`.

```bash
sed -n '133,190p' src/metadata.ts
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
    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    (settings.enableTitle &&
      isEmptyValue(frontMatter[settings.titleFieldName])) ||
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
    } catch (error) {
      new Notice(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        8000,
      );
      console.error("generateMetadata error:", error);
    }
  }
}
```

### Prompt Building: `buildPrompt()`

Constructs a structured prompt with numbered requirements for tags, description, and optionally title. Includes a JSON template so the LLM returns parseable output.

```bash
sed -n '11,46p' src/metadata.ts
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

### Response Parsing: `parseMetadataResponse()` and `tryParseFromText()`

The parser uses a multi-match strategy to handle varied LLM output formats:

1. **Non-greedy scan** — `/{[\s\S]*?}/g` finds all minimal JSON candidates; the last valid one wins (LLMs tend to put the answer last)
2. **Greedy fallback** — `/{[\s\S]*}/` handles JSON with nested braces
3. **Code fence extraction** — strips `` ```json `` wrappers before retrying

`isValidMetadataResponse()` type-guards the parsed object, accepting only string-valued `tags`, `description`, and `title` fields.

```bash
sed -n '48,96p' src/metadata.ts
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

### Helper Functions: `parseTags()`, `stripSurroundingQuotes()`, `isEmptyValue()`, `resolveUpdateMethod()`

These pure functions handle tag splitting, quote removal, empty-value detection, and update-method resolution. `resolveUpdateMethod` delegates to `isEmptyValue` to avoid duplicating the empty-check logic.

```bash
sed -n '98,131p' src/metadata.ts
```

```output
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

export function isEmptyValue(value: unknown): boolean {
  if (!value) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((v) => String(v).trim() === "");
  }
  return false;
}

export function resolveUpdateMethod(
  force: boolean,
  currentValue: unknown,
): "update" | "keep" {
  if (force) return "update";
  return isEmptyValue(currentValue) ? "update" : "keep";
}
```

### Write-back: `addMetadataWithClaude()`

The private orchestrator that ties together content extraction, API call, parsing, and frontmatter writes. Tags are always appended (deduped); description and title use `resolveUpdateMethod` to decide update vs. keep. Each frontmatter write is individually try/caught so a failure in one field doesn't block the others.

```bash
sed -n '192,301p' src/metadata.ts
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

  const metadata: MetadataResponse = parseMetadataResponse(response) ?? {};

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

## Utilities — `src/utils.ts`

### Claude API Call: `callClaude()`

Creates an Anthropic client with `dangerouslyAllowBrowser: true` (safe in Obsidian's Electron renderer). Shows a loading notice, sends the prompt, and handles specific error types (auth, rate limit, server, generic API) with user-visible notices. On error, it re-throws so the caller can catch and return false.

```bash
sed -n '5,58p' src/utils.ts
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

### Tokenization: `splitIntoTokens()` and `joinTokens()`

A custom tokenizer splits content into CJK characters, words, punctuation, and newlines. `joinTokens()` reconstructs text with proper spacing — no space after newlines, no space before CJK/punctuation.

```bash
sed -n '60,81p' src/utils.ts
```

```output
export function splitIntoTokens(str: string): string[] {
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

### Truncation Strategies

Three strategies reduce content length before sending to the API:

- **`truncateHeadOnly`** — First N tokens with `...` suffix
- **`truncateHeadTail`** — 80% from start + 20% from end, separated by `...`
- **`truncateHeading`** — Extracts heading outline + first paragraph per section (30 tokens max), fills remaining budget with body text

All strategies guard the `...` ellipsis: only appended when content was actually truncated.

```bash
sed -n '83,141p' src/utils.ts
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
      const truncated = lineTokens.slice(0, 30);
      const suffix = truncated.length < lineTokens.length ? "..." : "";
      newLines.push(`${joinTokens(truncated)}${suffix}`);
      captureNextParagraph = false;
    }
  }
  let result = newLines.join("\n");
  const totalTokens = splitIntoTokens(result);
  if (totalTokens.length > limit) {
    result = joinTokens(totalTokens.slice(0, limit));
  } else {
    const remainingTokens = limit - totalTokens.length;
    const headTokens = tokens.slice(0, remainingTokens);
    if (headTokens.length > 0) {
      const suffix = headTokens.length < tokens.length ? "..." : "";
      const head = `${joinTokens(headTokens)}${suffix}`;
      result = `Outline: \n${result}\n\nBody: ${head}`;
    } else {
      result = `Outline: \n${result}`;
    }
  }
  return result;
}
```

### Content Extraction: `getContent()`

Reads the file from the vault, early-returns on empty content or unlimited budget (`limit <= 0`), then dispatches to the appropriate truncation strategy.

```bash
sed -n '143,172p' src/utils.ts
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

### Frontmatter Updates: `updateFrontMatter()`

Uses Obsidian's `processFrontMatter()` for safe, atomic writes. Three modes:

- **`append`** — Merges arrays with `Set` deduplication (tags)
- **`update`** — Overwrites the field
- **`keep`** — Only writes if the field is undefined

```bash
sed -n '174,198p' src/utils.ts
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

## Settings UI — `src/settingsTab.ts`

The settings tab organizes controls into sections: API settings (password-masked key, model dropdown), update behavior (method, truncation toggle with dependent fields), and per-field configuration (field name + prompt textarea for tags, description, title). The title section disables when `enableTitle` is off.

```bash
sed -n '12,48p' src/settingsTab.ts
```

```output
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
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model to use for metadata generation")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
          .addOption("claude-opus-4-6", "Claude Opus 4.6")
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
          .setValue(this.plugin.settings.anthropicModel)
          .onChange(async (value) => {
            this.plugin.settings.anthropicModel = value;
            await this.plugin.saveSettings();
          }),
      );
```

## Build System — `build.ts`

Uses Bun's native bundler to produce a single CommonJS `main.js`. Externals `obsidian` and `electron` (provided by the host). Minified in production, unminified in dev. The `--watch` flag is parsed but doesn't currently trigger Bun's watch mode (see issue #82).

```bash
sed -n '1,19p' build.ts
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

## Tests

94 tests across 3 files cover all pure functions. Tests use Bun's built-in test runner with Obsidian API mocks in `test-preload.ts`.

```bash
grep -c 'test\|it(' src/main.test.ts src/metadata.test.ts src/utils.test.ts
```

```output
src/main.test.ts:13
src/metadata.test.ts:53
src/utils.test.ts:40
```

```bash
sed -n '1,10p' src/test-preload.ts
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

## Validation — `scripts/validate-plugin.ts`

Pre-release validation: checks manifest fields, version consistency between `package.json` and `manifest.json`, runs code quality checks, and builds the plugin.

```bash
sed -n '6,33p' scripts/validate-plugin.ts
```

```output
const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
console.log(`🔍 Validating ${manifest.name || "plugin"}...\n`);

let errors = 0;

// Check manifest.json
if (!manifest.id || !manifest.name || !manifest.version) {
  console.error("✗ manifest.json missing required fields");
  errors++;
} else {
  console.log(`✓ manifest.json — ${manifest.name} v${manifest.version}`);
}

// Check package.json version matches manifest
try {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  if (pkg.version !== manifest.version) {
    console.error(
      `✗ Version mismatch: package.json (${pkg.version}) != manifest.json (${manifest.version})`,
    );
    errors++;
  } else {
    console.log("✓ Version numbers match");
  }
} catch (error) {
  console.error("✗ Version check failed:", error);
  errors++;
}
```

## Version Bump — `version-bump.ts`

Reads the version from `package.json` (via `npm_package_version` env var), updates `manifest.json` version and adds an entry to `versions.json` mapping the new version to `minAppVersion`.

```bash
sed -n '1,19p' version-bump.ts
```

```output
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error("No version found in package.json");
}

// Update manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// Update versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Updated to version ${targetVersion}`);
```

## Concerns

### Open Issues

- **#81 — System message separation.** The prompt sends everything (instructions + content) in a single user message. Using a system message for instructions and user message for content would improve reliability and is standard practice with the Anthropic API.
- **#82 — `--watch` flag is parsed but doesn't trigger Bun's file watcher.** `build.ts` checks for `--watch` and logs "Watching for changes..." but doesn't actually set up a watch loop.
- **#83 — tsconfig excludes test files.** Test files aren't type-checked during `bun run typecheck`, which could allow type errors to slip into tests.
- **#84 — API key check and contentStr variable.** The `settings.anthropicApiKey === ""` check is redundant (the falsy check already covers it), and `contentStr` could use `const` with reassignment refactored.

### Code Quality

- **Token counting is approximate.** The regex-based tokenizer doesn't align with LLM tokenization (BPE). Actual API token usage may differ significantly from the configured `maxTokens`.
- **No retry logic.** Transient API errors (rate limits, 500s) surface immediately as failures. A simple backoff-retry for `RateLimitError` and `InternalServerError` would improve reliability.
- **`dangerouslyAllowBrowser: true`** is documented as safe in Electron but will trigger warnings if the code is ever used outside Obsidian's context.

