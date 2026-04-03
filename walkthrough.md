# Metadator Walkthrough

*2026-04-03T18:38:28Z by Showboat 0.6.1*
<!-- showboat-id: 3766c5c3-9c27-4e20-9508-cf2f398030ed -->

## Overview

Metadator is an Obsidian plugin that generates metadata — tags, description, and optionally a title — for markdown notes using the Anthropic Claude API. The user runs a command, the plugin extracts and optionally truncates the note content, sends it to Claude with a structured prompt, parses the JSON response, and writes the results into YAML frontmatter.

**Key technologies:** TypeScript, Obsidian Plugin API, Anthropic SDK, Bun (runtime + bundler + test runner), Biome (lint + format).

**Entry point:** `src/main.ts` → `MetadataToolPlugin` class extending Obsidian's `Plugin`.

**Source layout:**
- `src/main.ts` — Plugin lifecycle, command registration, settings migration
- `src/settings.ts` — Settings interface and defaults
- `src/settingsTab.ts` — Settings UI
- `src/metadata.ts` — Prompt building, response parsing, orchestration
- `src/utils.ts` — Claude API call, content extraction, frontmatter writing
- `build.ts` — Bun bundler producing `main.js` (CommonJS, required by Obsidian)
- `version-bump.ts` — Syncs version across package.json, manifest.json, versions.json

## Settings Interface

Everything starts with configuration. `src/settings.ts` defines the `MetadataToolSettings` interface — the shape of all user-configurable options — and `DEFAULT_SETTINGS` providing sensible defaults.

```bash
head -26 src/settings.ts
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

The defaults configure Claude Sonnet 4.6, a 1000-token content limit with head-only truncation, and `preserve_existing` update behavior (only populate empty fields). The three prompt strings are user-editable instructions sent to Claude for each field.

```bash
tail -n +28 src/settings.ts
```

```output
export const DEFAULT_SETTINGS: MetadataToolSettings = {
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6",

  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",

  enableTitle: true,
  debugLogging: false,

  truncateContent: true,
  contentTokenLimit: 1000,
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

## Plugin Entry Point

`src/main.ts` defines the plugin class and a settings migration function. The migration handles renamed values from earlier versions — legacy `updateMethod` values (`force`, `update_all`, `no-llm`, `empty_only`) map to the current enum, old model IDs update to their current equivalents, and the renamed `maxTokens` → `contentTokenLimit` field is carried forward.

```bash
head -37 src/main.ts
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

  if (loaded.anthropicModel === "claude-opus-4-5-20251101") {
    loaded.anthropicModel = "claude-opus-4-6";
  }

  if (
    loaded.maxTokens !== undefined &&
    loaded.contentTokenLimit === undefined
  ) {
    loaded.contentTokenLimit = loaded.maxTokens;
    delete loaded.maxTokens;
  }

  return loaded;
}
```

The plugin class itself is minimal. `onload()` reads persisted settings (with migration), registers the single command, and adds the settings tab. Settings are merged with defaults via `Object.assign` so new fields get default values on upgrade.

```bash
tail -n +39 src/main.ts
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

## Content Extraction and Tokenization

When the command runs, note content must be extracted and optionally truncated before sending to the API. `src/utils.ts` handles this with a custom tokenizer and three truncation strategies.

The tokenizer splits text into tokens using a regex that handles CJK characters (one token each), Latin words/numbers (one token per word), punctuation, and newlines. This is a rough approximation — not a BPE tokenizer — but good enough for controlling prompt length.

```bash
head -87 src/utils.ts | tail -n +62
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

Three truncation strategies are available:

- **head_only** — Take the first N tokens. Simple and predictable.
- **head_tail** — 80% from the start, 20% from the end. Captures intro and conclusion.
- **heading** — Extract headings + first paragraph per section as an outline, then fill remaining budget with body text.

```bash
head -150 src/utils.ts | tail -n +89
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
    const headTokens = tokens.slice(
      totalTokens.length,
      totalTokens.length + remainingTokens,
    );
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

`getContent()` ties it together — reads the file from the vault, tokenizes, and applies the selected truncation method. When `limit <= 0` (truncation disabled), the full content is returned.

```bash
head -181 src/utils.ts | tail -n +152
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

## Prompt Construction

`buildPrompt()` in `src/metadata.ts` assembles the system message and user message. The system message instructs Claude on how to generate each field, using the user-customizable prompt strings. The title section is conditionally included based on `enableTitle`. The user message wraps the note content in `<article>` XML tags.

```bash
head -49 src/metadata.ts | tail -n +16
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

## Claude API Call

`callClaude()` in `src/utils.ts` creates an Anthropic client (with `dangerouslyAllowBrowser: true` — safe inside Obsidian's Electron renderer), sends the request, and handles errors with user-facing notices for common failure modes: authentication, rate limiting, server overload.

```bash
head -60 src/utils.ts
```

```output
import Anthropic from "@anthropic-ai/sdk";
import { type App, Notice, type TFile } from "obsidian";
import type { MetadataToolSettings } from "./settings";

export async function callClaude(
  system: string,
  userMessage: string,
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
      system,
      messages: [{ role: "user", content: userMessage }],
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

## Response Parsing

Claude's response should be JSON, but LLMs can wrap it in markdown code fences, add commentary, or return multiple JSON objects. `parseMetadataResponse()` handles this robustly:

1. Try all non-greedy `{...}` matches, keeping the last valid one (LLMs tend to put the final answer last)
2. Fall back to greedy `{...}` for JSON with nested braces
3. If that fails, try extracting from markdown code fences
4. Validate that the parsed object only contains the expected string fields

```bash
head -99 src/metadata.ts | tail -n +51
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

## Frontmatter Writing

`updateFrontMatter()` uses Obsidian's `processFrontMatter()` API — the correct way to modify YAML frontmatter. It supports three write modes:

- **append** — For tags: merges new values into existing array, deduplicating with `Set`
- **update** — Overwrites the field unconditionally
- **keep** — Only writes if the field is undefined (preserves existing values)

```bash
tail -n +183 src/utils.ts
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

## Orchestration: generateMetadata

`generateMetadata()` in `src/metadata.ts` is the top-level function called by the command. It validates preconditions (file open, is markdown, API key set), checks whether any fields need populating based on the update method, then delegates to `addMetadataWithClaude()`.

The helper functions `isEmptyValue()` and `resolveUpdateMethod()` determine per-field whether to update or keep. Tags get special treatment — they use "append" mode to merge with existing tags rather than replacing.

```bash
head -134 src/metadata.ts | tail -n +101
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

```bash
head -192 src/metadata.ts | tail -n +136
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

`addMetadataWithClaude()` is the inner function that does the actual work: extract content, build prompt, call Claude, parse response, write fields. The `writeField` helper wraps each `updateFrontMatter` call with error handling and change tracking.

```bash
tail -n +194 src/metadata.ts
```

```output
async function addMetadataWithClaude(
  file: TFile,
  app: App,
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

  let response: string;
  try {
    response = await callClaude(system, userMessage, settings);
  } catch (error) {
    console.error("Error calling Claude:", error);
    return false;
  }

  if (settings.debugLogging) {
    console.log("[Metadator] Response:", response);
  }

  if (!response) {
    return false;
  }

  const metadata: MetadataResponse = parseMetadataResponse(response) ?? {};

  let hasChanges = false;

  async function writeField(
    fieldName: string,
    value: string | string[],
    method: "append" | "update" | "keep",
  ): Promise<boolean> {
    try {
      await updateFrontMatter(file, app, fieldName, value, method);
      return method !== "keep";
    } catch (error) {
      new Notice(
        `Failed to write ${fieldName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`updateFrontMatter error (${fieldName}):`, error);
      return false;
    }
  }

  // Update tags
  if (metadata.tags) {
    const tags = parseTags(metadata.tags);
    const tagsMethod = resolveUpdateMethod(
      force,
      frontMatter[settings.tagsFieldName],
    );
    const method = tagsMethod === "update" ? "append" : "keep";
    if (await writeField(settings.tagsFieldName, tags, method)) {
      hasChanges = true;
    }
  }

  // Update description
  if (metadata.description) {
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.descriptionFieldName],
    );
    if (
      await writeField(
        settings.descriptionFieldName,
        metadata.description,
        method,
      )
    ) {
      hasChanges = true;
    }
  }

  // Update title
  if (settings.enableTitle && metadata.title) {
    const title = stripSurroundingQuotes(metadata.title);
    const method = resolveUpdateMethod(
      force,
      frontMatter[settings.titleFieldName],
    );
    if (await writeField(settings.titleFieldName, title, method)) {
      hasChanges = true;
    }
  }

  return hasChanges;
}
```

## Build System

`build.ts` uses Bun's native bundler to produce a single CommonJS `main.js` — the format Obsidian requires. Externals (`obsidian`, `electron`) are excluded since Obsidian provides them at runtime. In watch mode, it uses Node's `fs.watch` with a 100ms debounce to rebuild on `.ts` file changes.

```bash
head -38 build.ts
```

```output
import { watch } from "node:fs";
import { resolve } from "node:path";

const isWatch = process.argv.includes("--watch");

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

await build();

if (isWatch) {
  console.log("Watching src/ for changes...");
  let debounce: ReturnType<typeof setTimeout> | null = null;
  watch(resolve("src"), { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`Rebuilding (${filename} changed)...`);
      await build();
    }, 100);
  });
}
```

`version-bump.ts` keeps `manifest.json` and `versions.json` in sync with `package.json` — it reads the version from `npm_package_version` (set by `bun run`), updates both files, and preserves the existing `minAppVersion`.

```bash
head -19 version-bump.ts
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

### Code Quality

1. **`truncateHeading` body offset bug** — When the outline fits within the token budget and body text is appended, `headTokens` is sliced starting at `totalTokens.length` — the count of outline tokens. But `tokens` is the original full-document token array, and the outline tokens don't necessarily align positionally with the original tokens (headings are kept but body paragraphs are replaced with truncated summaries). This means the body section may skip or duplicate content depending on how the outline rearranges things. The intent seems to be "fill remaining budget with content not already in the outline," but the index math assumes a 1:1 positional mapping that doesn't hold after outline construction.

2. **`writeField` returns `method !== "keep"` regardless of actual write** — When `method` is `"update"` or `"append"`, `writeField` returns `true` even if `updateFrontMatter` was a no-op (e.g., appending tags that already exist). This means `hasChanges` can be `true` and the "Metadata updated successfully" notice can fire even when nothing changed. Minor UX issue.

3. **`updateFrontMatter` silently ignores non-array append** — If `method === "append"` but `value` is a string (not an array), the function does nothing. The caller always passes arrays for append mode, so this isn't a bug in practice, but the silent no-op could mask future mistakes.

4. **`callClaude` creates a new Anthropic client on every call** — The SDK client is instantiated fresh each invocation. For a single-call-per-command plugin this is fine, but it's worth noting the pattern doesn't reuse connections.

### Community Standards

5. **No `styles.css`** — Obsidian's plugin submission guidelines expect `styles.css` in the release assets even if empty. The GitHub Actions release workflow should verify this requirement if submitting to the community plugin directory.

6. **`dangerouslyAllowBrowser: true`** — Correctly justified in the comment. This is the standard pattern for Obsidian plugins using the Anthropic SDK, since Obsidian runs in Electron's renderer process.

### Robustness

7. **No retry logic** — A single transient API failure (rate limit, 500) fails the entire operation. The error is surfaced via Notice, which is fine, but a single retry with backoff would improve reliability without complexity.

8. **`needsMetadata` makes an API call even if only one field needs population** — When `preserve_existing` is active and two of three fields are populated, Claude still generates all three fields (the prompt asks for all), but only the empty one gets written. The API cost is the same regardless. A future optimization could trim the prompt to only request missing fields.

