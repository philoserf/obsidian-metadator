# Metadator Code Walkthrough

*2026-03-09T03:51:45Z by Showboat 0.6.1*
<!-- showboat-id: 4bee6fab-2491-413a-bd03-4f4cb0462df8 -->

## Overview

Metadator is an Obsidian plugin that generates metadata — tags, description, and title — for markdown notes using the Anthropic Claude API. The user triggers a command, the plugin reads the note, sends its content to Claude with customizable prompts, parses the structured JSON response, and writes the results into YAML frontmatter.

This walkthrough follows the code linearly: configuration and types first, then the plugin lifecycle, utilities, core logic, settings UI, build system, and testing.

---

## 1. Project Structure

The project has a small footprint — five source modules, three test files, and a handful of config and build files.

```bash
find . -type f \( -name "*.ts" -o -name "*.json" \) \
  \! -path "./node_modules/*" \! -path "./.obsidian/*" \! -name "versions.json" \
  \! -name "bun.lock" \! -name "main.js" \
  | sort
```

```output
./.claude/settings.json
./biome.json
./build.ts
./manifest.json
./package.json
./scripts/validate-plugin.ts
./src/main.test.ts
./src/main.ts
./src/metadata.test.ts
./src/metadata.ts
./src/settings.ts
./src/settingsTab.ts
./src/test-preload.ts
./src/utils.test.ts
./src/utils.ts
./tsconfig.json
./version-bump.ts
```

The single production dependency is the Anthropic SDK. Everything else is dev tooling.

```bash
cat package.json | grep -A1 "dependencies" | head -5
```

```output
  "dependencies": {
    "@anthropic-ai/sdk": "^0.78.0"
```

---

## 2. Settings — The Configuration Contract

`src/settings.ts` is the simplest module. It defines the `MetadataToolSettings` interface and provides defaults. Every configurable behavior flows from this type.

```bash
cat -n src/settings.ts
```

```output
     1	export interface MetadataToolSettings {
     2	  anthropicApiKey: string;
     3	  anthropicModel: string;
     4	
     5	  // Field names in frontmatter
     6	  tagsFieldName: string;
     7	  descriptionFieldName: string;
     8	  titleFieldName: string;
     9	
    10	  // Feature toggles
    11	  enableTitle: boolean;
    12	
    13	  // Content truncation
    14	  truncateContent: boolean;
    15	  maxTokens: number;
    16	  truncateMethod: "head_only" | "head_tail" | "heading";
    17	
    18	  // Update behavior
    19	  updateMethod: "always_regenerate" | "preserve_existing";
    20	
    21	  // Prompts
    22	  tagsPrompt: string;
    23	  descriptionPrompt: string;
    24	  titlePrompt: string;
    25	}
    26	
    27	export const DEFAULT_SETTINGS: MetadataToolSettings = {
    28	  anthropicApiKey: "",
    29	  anthropicModel: "claude-sonnet-4-6",
    30	
    31	  tagsFieldName: "tags",
    32	  descriptionFieldName: "description",
    33	  titleFieldName: "title",
    34	
    35	  enableTitle: true,
    36	
    37	  truncateContent: true,
    38	  maxTokens: 1000,
    39	  truncateMethod: "head_only",
    40	
    41	  updateMethod: "preserve_existing",
    42	
    43	  tagsPrompt:
    44	    "Select 3-5 relevant tags in lowercase with hyphens instead of spaces (e.g., 'knowledge-management', 'note-taking')",
    45	  descriptionPrompt:
    46	    "Write a concise but useful summary in 1-2 sentences that captures the main purpose and key points",
    47	  titlePrompt:
    48	    "Create a simple, concise title with minimal adjectives that clearly states the topic",
    49	};
```

Key design choices visible here:

- **Frontmatter field names are configurable** (lines 6-8). Users aren't locked into `tags`/`description`/`title` — they can use whatever YAML keys their vault expects.
- **`updateMethod`** has exactly two values: `always_regenerate` (overwrite everything) or `preserve_existing` (only fill empty fields). Earlier versions had four values that were confusingly named; the migration in `main.ts` handles the old names.
- **`maxTokens`** (line 15) refers to the *input* truncation limit — how many tokens of note content to send to Claude. This is **not** the API `max_tokens` parameter (response limit), which is hardcoded to 2048 in `callClaude()`. The naming overlap is a known concern (#65).
- **Custom prompts** (lines 22-24) let users tune what Claude generates without touching code.

---

## 3. Plugin Entry Point — `src/main.ts`

This is the Obsidian plugin lifecycle: load settings, register command, attach settings UI.

```bash
cat -n src/main.ts
```

```output
     1	import { Plugin } from "obsidian";
     2	import { generateMetadata } from "./metadata";
     3	import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
     4	import { MetadataToolSettingTab } from "./settingsTab";
     5	
     6	export function migrateSettings(
     7	  loaded: Record<string, unknown> | null,
     8	): Record<string, unknown> | null {
     9	  if (!loaded) return loaded;
    10	
    11	  if (loaded.updateMethod === "force" || loaded.updateMethod === "update_all") {
    12	    loaded.updateMethod = "always_regenerate";
    13	  } else if (
    14	    loaded.updateMethod === "no-llm" ||
    15	    loaded.updateMethod === "empty_only"
    16	  ) {
    17	    loaded.updateMethod = "preserve_existing";
    18	  }
    19	
    20	  if (loaded.anthropicModel === "claude-sonnet-4-5-20250929") {
    21	    loaded.anthropicModel = "claude-sonnet-4-6";
    22	  }
    23	
    24	  if (loaded.anthropicModel === "claude-opus-4-5-20251101") {
    25	    loaded.anthropicModel = "claude-opus-4-6";
    26	  }
    27	
    28	  return loaded;
    29	}
    30	
    31	export default class MetadataToolPlugin extends Plugin {
    32	  settings: MetadataToolSettings = DEFAULT_SETTINGS;
    33	
    34	  async onload(): Promise<void> {
    35	    await this.loadSettings();
    36	
    37	    this.addCommand({
    38	      id: "generate-metadata",
    39	      name: "Generate metadata for current note",
    40	      callback: async () => {
    41	        await generateMetadata(this.app, this.settings);
    42	      },
    43	    });
    44	
    45	    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
    46	  }
    47	
    48	  onunload(): void {}
    49	
    50	  async loadSettings(): Promise<void> {
    51	    const loadedSettings = migrateSettings(await this.loadData());
    52	    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
    53	  }
    54	
    55	  async saveSettings(): Promise<void> {
    56	    await this.saveData(this.settings);
    57	  }
    58	}
```

### Settings migration (lines 6-29)

`migrateSettings` runs on every load, before defaults are merged. It handles two categories of legacy values:

1. **`updateMethod`**: Four old values collapse to two — `"force"` and `"update_all"` become `"always_regenerate"`; `"no-llm"` and `"empty_only"` become `"preserve_existing"`.
2. **Model names**: Date-stamped model IDs (`claude-sonnet-4-5-20250929`) are remapped to current short names (`claude-sonnet-4-6`).

Migrations are idempotent — running on already-migrated data is a no-op.

### Plugin class (lines 31-58)

`onload()` does three things:
1. Loads and migrates persisted settings (line 51), then merges with `DEFAULT_SETTINGS` via `Object.assign` (line 52). This means new settings added in future versions get their defaults automatically.
2. Registers a single command: "Generate metadata for current note" (line 37-43). The command delegates entirely to `generateMetadata()` from `metadata.ts`.
3. Adds the settings tab to Obsidian's preferences (line 45).

`onunload()` is empty — no cleanup needed. The plugin doesn't register event listeners or intervals.

---

## 4. Utilities — `src/utils.ts`

The utility module provides four capabilities: Claude API calls, tokenization, content truncation, and frontmatter writes.

### 4a. Calling the Anthropic API

```bash
sed -n "1,58p" src/utils.ts | cat -n
```

```output
     1	import Anthropic from "@anthropic-ai/sdk";
     2	import { type App, Notice, type TFile } from "obsidian";
     3	import type { MetadataToolSettings } from "./settings";
     4	
     5	export async function callClaude(
     6	  prompt: string,
     7	  settings: MetadataToolSettings,
     8	): Promise<string> {
     9	  const notice = new Notice("Generating metadata...", 0);
    10	
    11	  // Safe in Obsidian's Electron renderer — no browser security concerns apply
    12	  const anthropic = new Anthropic({
    13	    apiKey: settings.anthropicApiKey,
    14	    dangerouslyAllowBrowser: true,
    15	  });
    16	
    17	  try {
    18	    const message = await anthropic.messages.create({
    19	      model: settings.anthropicModel,
    20	      max_tokens: 2048,
    21	      messages: [{ role: "user", content: prompt }],
    22	    });
    23	
    24	    notice.hide();
    25	
    26	    if (message.content.length > 0 && message.content[0].type === "text") {
    27	      return message.content[0].text;
    28	    }
    29	
    30	    throw new Error("No text content in response");
    31	  } catch (error) {
    32	    notice.hide();
    33	
    34	    if (error instanceof Anthropic.AuthenticationError) {
    35	      new Notice(
    36	        "Authentication failed. Please check your API key in Settings → Metadator",
    37	        8000,
    38	      );
    39	    } else if (error instanceof Anthropic.RateLimitError) {
    40	      new Notice(
    41	        "Rate limit exceeded. Please wait a moment and try again.",
    42	        8000,
    43	      );
    44	    } else if (error instanceof Anthropic.InternalServerError) {
    45	      new Notice(
    46	        "API is currently overloaded. Please try again in a moment.",
    47	        8000,
    48	      );
    49	    } else if (error instanceof Anthropic.APIError) {
    50	      new Notice(`API error: ${error.message}`, 8000);
    51	    } else {
    52	      new Notice("An unknown API error occurred", 8000);
    53	    }
    54	
    55	    console.error("Claude API error:", error);
    56	    throw error;
    57	  }
    58	}
```

**`callClaude`** (lines 5-58) is the only function that touches the network.

- **`dangerouslyAllowBrowser: true`** (line 14) — The Anthropic SDK warns against browser use because it would expose the API key in a web app. Obsidian runs in Electron (a local desktop app), so this is safe. The comment at line 11 explains this.
- **`max_tokens: 2048`** (line 20) — The *response* token limit. Hardcoded, not user-configurable. This is separate from `settings.maxTokens` which controls *input* truncation.
- **Error handling** (lines 31-57) — Four specific Anthropic error types get user-friendly notices (shown for 8 seconds). The error is then re-thrown so callers can respond. This is the first layer of a three-layer error flow.

**Concern**: No explicit network timeout. The SDK has its own default, but there's no way for users to control it if their network is slow.

### 4b. Tokenization

```bash
sed -n "60,81p" src/utils.ts | cat -n
```

```output
     1	export function splitIntoTokens(str: string): string[] {
     2	  const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;，。！？；#]|[\n]/g;
     3	  const tokens = str.match(regex);
     4	  return tokens || [];
     5	}
     6	
     7	export function joinTokens(tokens: string[]): string {
     8	  let result = "";
     9	  for (let i = 0; i < tokens.length; i++) {
    10	    const token = tokens[i];
    11	    if (token === "\n") {
    12	      result += token;
    13	    } else if (/[\u4e00-\u9fa5]|[.,!?;，。！？；#]/.test(token)) {
    14	      result += token;
    15	    } else {
    16	      const prevToken = i > 0 ? tokens[i - 1] : undefined;
    17	      const needsSpace = i > 0 && prevToken !== "\n";
    18	      result += (needsSpace ? " " : "") + token;
    19	    }
    20	  }
    21	  return result.trim();
    22	}
```

The tokenizer is a custom regex-based splitter — *not* a BPE tokenizer like Claude's actual tokenizer. It's an approximation used only for truncation limits.

The regex on line 2 has four alternations:
1. `[\u4e00-\u9fa5]` — Each CJK character is one token
2. `[a-zA-Z0-9]+` — English words (including numbers) are one token each
3. `[.,!?;，。！？；#]` — Punctuation marks are individual tokens (including CJK punctuation)
4. `[\n]` — Newlines are individual tokens

`joinTokens` reverses the process, inserting spaces between English words but not around CJK characters or punctuation. It's a lossy round-trip — some whitespace is lost — but that's fine since these functions exist to estimate size, not to reproduce the original text exactly.

**Concern**: The `#` character being a separate token matters because markdown headings like `## Title` become three tokens (`#`, `#`, `Title`). This inflates the token count for heading-heavy documents (#68).

### 4c. Truncation Methods

Three strategies for keeping content within the token limit:

```bash
sed -n "83,101p" src/utils.ts | cat -n
```

```output
     1	export function truncateHeadOnly(tokens: string[], limit: number): string {
     2	  const truncated = tokens.slice(0, limit);
     3	  const suffix = truncated.length < tokens.length ? "..." : "";
     4	  return `${joinTokens(truncated)}${suffix}`;
     5	}
     6	
     7	export function truncateHeadTail(tokens: string[], limit: number): string {
     8	  if (limit >= tokens.length) {
     9	    return joinTokens(tokens);
    10	  }
    11	  const left = Math.max(1, Math.floor(limit * 0.8));
    12	  const right = Math.max(0, limit - left);
    13	  const leftTokens = tokens.slice(0, left);
    14	  if (right <= 0) {
    15	    return joinTokens(leftTokens);
    16	  }
    17	  const rightTokens = tokens.slice(-right);
    18	  return `${joinTokens(leftTokens)}\n...\n${joinTokens(rightTokens)}`;
    19	}
```

**`truncateHeadOnly`** — Take the first N tokens, append `...` if content was actually truncated. The ellipsis guard (line 3) prevents adding `...` when the content fits within the limit.

**`truncateHeadTail`** — 80/20 split: 80% from the start, 20% from the end, with `\n...\n` between them. The early-return on line 8 avoids producing garbled output when the limit exceeds the content length. `Math.max(1, ...)` on line 11 ensures at least one token on the left side.

Now the most complex truncation method — heading-based extraction:

```bash
sed -n "103,141p" src/utils.ts | cat -n
```

```output
     1	export function truncateHeading(
     2	  contentStr: string,
     3	  tokens: string[],
     4	  limit: number,
     5	): string {
     6	  let lines = contentStr.split("\n");
     7	  lines = lines.filter((line) => line.trim() !== "");
     8	
     9	  const newLines: string[] = [];
    10	  let captureNextParagraph = false;
    11	  for (const line of lines) {
    12	    if (line.startsWith("#")) {
    13	      newLines.push(line);
    14	      captureNextParagraph = true;
    15	    } else if (captureNextParagraph && line.trim() !== "") {
    16	      const lineTokens = splitIntoTokens(line);
    17	      const truncated = lineTokens.slice(0, 30);
    18	      const suffix = truncated.length < lineTokens.length ? "..." : "";
    19	      newLines.push(`${joinTokens(truncated)}${suffix}`);
    20	      captureNextParagraph = false;
    21	    }
    22	  }
    23	  let result = newLines.join("\n");
    24	  const totalTokens = splitIntoTokens(result);
    25	  if (totalTokens.length > limit) {
    26	    result = joinTokens(totalTokens.slice(0, limit));
    27	  } else {
    28	    const remainingTokens = limit - totalTokens.length;
    29	    const headTokens = tokens.slice(0, remainingTokens);
    30	    if (headTokens.length > 0) {
    31	      const suffix = headTokens.length < tokens.length ? "..." : "";
    32	      const head = `${joinTokens(headTokens)}${suffix}`;
    33	      result = `Outline: \n${result}\n\nBody: ${head}`;
    34	    } else {
    35	      result = `Outline: \n${result}`;
    36	    }
    37	  }
    38	  return result;
    39	}
```

**`truncateHeading`** builds a document outline with the first paragraph of each section:

1. **Extract structure** (lines 9-22): Walk through non-empty lines. Collect every heading (`#`-prefixed line) and the first non-empty paragraph after each heading, truncated to 30 tokens.
2. **Budget remaining tokens** (lines 24-37): If the outline itself exceeds the limit, truncate the outline. Otherwise, use remaining budget for raw content from the start of the document (`Body:` section).

This gives Claude the document structure plus as much body text as the budget allows — useful for long notes where headings signal topic distribution.

### 4d. Content Extraction

```bash
sed -n "143,172p" src/utils.ts | cat -n
```

```output
     1	export async function getContent(
     2	  app: App,
     3	  file: TFile,
     4	  limit: number = 1000,
     5	  method: "head_only" | "head_tail" | "heading" = "head_only",
     6	): Promise<string> {
     7	  let contentStr = await app.vault.read(file);
     8	
     9	  if (contentStr.length === 0) {
    10	    return "";
    11	  }
    12	
    13	  if (limit <= 0) {
    14	    return contentStr;
    15	  }
    16	
    17	  const tokens = splitIntoTokens(contentStr);
    18	
    19	  if (tokens.length > limit) {
    20	    if (method === "head_tail") {
    21	      contentStr = truncateHeadTail(tokens, limit);
    22	    } else if (method === "head_only") {
    23	      contentStr = truncateHeadOnly(tokens, limit);
    24	    } else if (method === "heading") {
    25	      contentStr = truncateHeading(contentStr, tokens, limit);
    26	    }
    27	  }
    28	
    29	  return contentStr;
    30	}
```

`getContent` reads the file and conditionally truncates. Three guard clauses:
- Empty file → return empty string (line 9)
- `limit <= 0` → return full content, no truncation (line 13). This is how truncation is disabled — the caller passes `-1`.
- `tokens.length <= limit` → content fits, return as-is (line 19 condition not met)

### 4e. Frontmatter Updates

```bash
sed -n "174,198p" src/utils.ts | cat -n
```

```output
     1	export async function updateFrontMatter(
     2	  file: TFile,
     3	  app: App,
     4	  key: string,
     5	  value: string | boolean | string[],
     6	  method: "append" | "update" | "keep",
     7	): Promise<void> {
     8	  await app.fileManager.processFrontMatter(file, (frontmatter) => {
     9	    if (method === "append") {
    10	      if (Array.isArray(value)) {
    11	        const existing = frontmatter[key];
    12	        const base = Array.isArray(existing)
    13	          ? existing
    14	          : existing != null
    15	            ? [String(existing)]
    16	            : [];
    17	        frontmatter[key] = Array.from(new Set(base.concat(value)));
    18	      }
    19	    } else if (method === "update") {
    20	      frontmatter[key] = value;
    21	    } else if (frontmatter[key] === undefined) {
    22	      frontmatter[key] = value;
    23	    }
    24	  });
    25	}
```

`updateFrontMatter` wraps Obsidian's `processFrontMatter` API — the correct way to modify YAML frontmatter atomically. Three write modes:

- **`append`** (line 9) — Used for tags. Merges new values with existing ones, deduplicating via `Set`. If the existing value is a string (not an array), it converts to a single-element array first (line 15). This handles the case where a user manually wrote `tags: some-tag` instead of `tags: [some-tag]`.
- **`update`** (line 19) — Overwrites unconditionally.
- **`keep`** (line 21) — Only writes if the key is `undefined` (not just empty). This is the "preserve existing" behavior.

**Design note**: Tags always use `append`, but description and title use `update` or `keep` depending on the `resolveUpdateMethod` result. This means tags accumulate across runs while description/title are replaced or preserved.

---

## 5. Core Logic — `src/metadata.ts`

This is the orchestration layer. It builds prompts, parses responses, and coordinates the write operations.

### 5a. Prompt Construction

```bash
sed -n "11,46p" src/metadata.ts | cat -n
```

```output
     1	export function buildPrompt(
     2	  contentStr: string,
     3	  settings: MetadataToolSettings,
     4	): string {
     5	  const promptParts = [
     6	    "I need to generate metadata for the following article. Requirements:",
     7	    "",
     8	    `1. Tags: ${settings.tagsPrompt}`,
     9	    "",
    10	    `2. Description: ${settings.descriptionPrompt}`,
    11	  ];
    12	
    13	  const jsonFields: string[] = [
    14	    '"tags": "tag1,tag2,tag3"',
    15	    '"description": "brief summary"',
    16	  ];
    17	
    18	  if (settings.enableTitle) {
    19	    promptParts.push("", `3. Title: ${settings.titlePrompt}`);
    20	    jsonFields.push('"title": "article title"');
    21	  }
    22	
    23	  promptParts.push(
    24	    "",
    25	    "Please return in the following JSON format:",
    26	    `{`,
    27	    `    ${jsonFields.join(",\n    ")}`,
    28	    `}`,
    29	    "",
    30	    "Article content:",
    31	    "",
    32	    contentStr,
    33	  );
    34	
    35	  return promptParts.join("\n");
    36	}
```

The prompt is built from parts rather than a template string for conditional title inclusion (line 18). The JSON template (lines 26-28) gives Claude an exact structure to follow. Note that tags are requested as a comma-separated string, not a JSON array — the `parseTags` function handles splitting later.

### 5b. Response Parsing

```bash
sed -n "48,97p" src/metadata.ts | cat -n
```

```output
     1	function isValidMetadataResponse(obj: unknown): obj is MetadataResponse {
     2	  if (typeof obj !== "object" || obj === null) return false;
     3	  const r = obj as Record<string, unknown>;
     4	  return (
     5	    (r.tags === undefined || typeof r.tags === "string") &&
     6	    (r.description === undefined || typeof r.description === "string") &&
     7	    (r.title === undefined || typeof r.title === "string")
     8	  );
     9	}
    10	
    11	export function parseMetadataResponse(
    12	  response: string,
    13	): MetadataResponse | null {
    14	  // Try matching JSON directly first to avoid corrupting embedded backticks
    15	  let jsonMatch = response.match(/{[\s\S]*}/);
    16	  if (!jsonMatch) {
    17	    // Extract content from code fence wrapper, then match JSON from that
    18	    const fenceMatch = response.match(/```(?:json)?\n?([\s\S]*?)```/);
    19	    if (fenceMatch) {
    20	      jsonMatch = fenceMatch[1].match(/{[\s\S]*}/);
    21	    }
    22	  }
    23	  if (!jsonMatch) {
    24	    return null;
    25	  }
    26	  try {
    27	    const parsed: unknown = JSON.parse(jsonMatch[0]);
    28	    return isValidMetadataResponse(parsed) ? parsed : null;
    29	  } catch {
    30	    return null;
    31	  }
    32	}
    33	
    34	export function parseTags(tagsString: string): string[] {
    35	  return tagsString
    36	    .split(",")
    37	    .map((tag) => tag.trim())
    38	    .filter((tag) => tag !== "");
    39	}
    40	
    41	export function stripSurroundingQuotes(str: string): string {
    42	  const trimmed = str.trim();
    43	  if (
    44	    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    45	    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    46	  ) {
    47	    return trimmed.substring(1, trimmed.length - 1);
    48	  }
    49	  return trimmed;
    50	}
```

**`parseMetadataResponse`** (lines 11-32) is the most defensive function in the codebase. It handles the variety of ways Claude might format its response:

1. **Direct JSON match** (line 15) — Try `/{[\s\S]*}/` first. The greedy `[\s\S]*` matches across newlines, capturing the outermost `{...}` block.
2. **Code fence fallback** (lines 17-21) — If no raw JSON is found, look for ` ```json ... ``` ` blocks and extract the inner JSON.
3. **Type validation** (line 28) — After `JSON.parse`, the `isValidMetadataResponse` type guard ensures all fields are either strings or undefined. This prevents Claude from returning unexpected types (arrays, numbers, nested objects).

The comment on line 14 explains the ordering: trying direct match first avoids corrupting backtick characters that might appear *inside* JSON values (like description text with code mentions).

**`parseTags`** (lines 34-38) — Simple comma split, trim, and filter empties. Handles trailing commas and whitespace.

**`stripSurroundingQuotes`** (lines 41-49) — Claude sometimes wraps titles in quotes. This removes matched pairs of single or double quotes but leaves mismatched quotes alone.

### 5c. Update Logic

```bash
sed -n "99,114p" src/metadata.ts | cat -n
```

```output
     1	export function isEmptyValue(value: unknown): boolean {
     2	  if (!value) return true;
     3	  if (typeof value === "string") return value.trim() === "";
     4	  if (Array.isArray(value)) {
     5	    return value.length === 0 || value.every((v) => String(v).trim() === "");
     6	  }
     7	  return false;
     8	}
     9	
    10	export function resolveUpdateMethod(
    11	  force: boolean,
    12	  currentValue: unknown,
    13	): "update" | "keep" {
    14	  if (force) return "update";
    15	  return isEmptyValue(currentValue) ? "update" : "keep";
    16	}
```

**`isEmptyValue`** handles the various shapes of "nothing": `null`, `undefined`, `""`, whitespace-only strings, empty arrays, and arrays of blank strings.

**`resolveUpdateMethod`** maps the user's `updateMethod` setting to a per-field write mode. If `force` is true (meaning `always_regenerate`), always overwrite. Otherwise, only update empty fields. This two-function pattern avoids duplicating the empty-check logic across the three fields.

### 5d. The Command Handler — `generateMetadata`

```bash
sed -n "116,173p" src/metadata.ts | cat -n
```

```output
     1	export async function generateMetadata(
     2	  app: App,
     3	  settings: MetadataToolSettings,
     4	): Promise<void> {
     5	  const file = app.workspace.getActiveFile();
     6	  if (!file) {
     7	    new Notice("Please open a file first");
     8	    return;
     9	  }
    10	
    11	  if (file.extension !== "md") {
    12	    new Notice("Current file is not a markdown file");
    13	    return;
    14	  }
    15	
    16	  // Check if API key is configured
    17	  if (!settings.anthropicApiKey || settings.anthropicApiKey === "") {
    18	    new Notice(
    19	      "Please configure your Anthropic API key in Settings → Metadator",
    20	      8000,
    21	    );
    22	    return;
    23	  }
    24	
    25	  const fm = app.metadataCache.getFileCache(file);
    26	  const frontMatter = fm?.frontmatter || {};
    27	
    28	  const updateAll = settings.updateMethod === "always_regenerate";
    29	
    30	  // Check if we need to call Claude for metadata
    31	  const needsMetadata =
    32	    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    33	    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    34	    (settings.enableTitle &&
    35	      isEmptyValue(frontMatter[settings.titleFieldName])) ||
    36	    updateAll;
    37	
    38	  if (needsMetadata) {
    39	    try {
    40	      const hasChanges = await addMetadataWithClaude(
    41	        file,
    42	        app,
    43	        settings,
    44	        frontMatter,
    45	        updateAll,
    46	      );
    47	      if (hasChanges) {
    48	        new Notice("Metadata updated successfully");
    49	      }
    50	    } catch (error) {
    51	      new Notice(
    52	        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    53	        8000,
    54	      );
    55	      console.error("generateMetadata error:", error);
    56	    }
    57	  }
    58	}
```

`generateMetadata` is the command entry point called from `main.ts`. It validates preconditions with early returns:

1. **No active file** (line 6) — File must be open
2. **Not markdown** (line 11) — Only `.md` files
3. **No API key** (line 17) — Directs user to settings

Then it reads the cached frontmatter (line 25) — Obsidian maintains this cache, so no file read is needed for the check. The `needsMetadata` logic (lines 31-36) determines whether Claude needs to be called at all. If all fields are populated and `updateMethod` is `preserve_existing`, no API call is made. This saves unnecessary API costs.

### 5e. The Orchestrator — `addMetadataWithClaude`

```bash
sed -n "175,285p" src/metadata.ts | cat -n
```

```output
     1	async function addMetadataWithClaude(
     2	  file: TFile,
     3	  app: App,
     4	  settings: MetadataToolSettings,
     5	  frontMatter: Record<string, unknown>,
     6	  force: boolean = false,
     7	): Promise<boolean> {
     8	  let contentStr = "";
     9	  if (settings.truncateContent) {
    10	    contentStr = await getContent(
    11	      app,
    12	      file,
    13	      settings.maxTokens,
    14	      settings.truncateMethod,
    15	    );
    16	  } else {
    17	    contentStr = await getContent(app, file, -1, "head_only");
    18	  }
    19	
    20	  const prompt = buildPrompt(contentStr, settings);
    21	
    22	  let response: string;
    23	  try {
    24	    response = await callClaude(prompt, settings);
    25	  } catch (error) {
    26	    console.error("Error calling Claude:", error);
    27	    return false;
    28	  }
    29	
    30	  if (!response) {
    31	    return false;
    32	  }
    33	
    34	  const metadata: MetadataResponse = parseMetadataResponse(response) ?? {};
    35	
    36	  let hasChanges = false;
    37	
    38	  // Update tags
    39	  if (metadata.tags) {
    40	    const tags = parseTags(metadata.tags);
    41	    try {
    42	      await updateFrontMatter(
    43	        file,
    44	        app,
    45	        settings.tagsFieldName,
    46	        tags,
    47	        "append",
    48	      );
    49	      hasChanges = true;
    50	    } catch (error) {
    51	      new Notice(
    52	        `Failed to write tags: ${error instanceof Error ? error.message : String(error)}`,
    53	      );
    54	      console.error("updateFrontMatter error (tags):", error);
    55	    }
    56	  }
    57	
    58	  // Update description
    59	  if (metadata.description) {
    60	    const method = resolveUpdateMethod(
    61	      force,
    62	      frontMatter[settings.descriptionFieldName],
    63	    );
    64	    try {
    65	      await updateFrontMatter(
    66	        file,
    67	        app,
    68	        settings.descriptionFieldName,
    69	        metadata.description,
    70	        method,
    71	      );
    72	      if (method === "update") {
    73	        hasChanges = true;
    74	      }
    75	    } catch (error) {
    76	      new Notice(
    77	        `Failed to write description: ${error instanceof Error ? error.message : String(error)}`,
    78	      );
    79	      console.error("updateFrontMatter error (description):", error);
    80	    }
    81	  }
    82	
    83	  // Update title
    84	  if (settings.enableTitle && metadata.title) {
    85	    const title = stripSurroundingQuotes(metadata.title);
    86	    const method = resolveUpdateMethod(
    87	      force,
    88	      frontMatter[settings.titleFieldName],
    89	    );
    90	    try {
    91	      await updateFrontMatter(
    92	        file,
    93	        app,
    94	        settings.titleFieldName,
    95	        title,
    96	        method,
    97	      );
    98	      if (method === "update") {
    99	        hasChanges = true;
   100	      }
   101	    } catch (error) {
   102	      new Notice(
   103	        `Failed to write title: ${error instanceof Error ? error.message : String(error)}`,
   104	      );
   105	      console.error("updateFrontMatter error (title):", error);
   106	    }
   107	  }
   108	
   109	  return hasChanges;
   110	}
```

This is the heart of the plugin. The flow is linear:

1. **Extract content** (lines 8-18) — Respects the user's truncation settings. If truncation is disabled, passes `-1` as the limit (which `getContent` interprets as "no limit").
2. **Build prompt and call Claude** (lines 20-28) — If the API call fails, `callClaude` has already shown a Notice and thrown. The catch here returns `false` to signal no changes.
3. **Parse response** (line 34) — `parseMetadataResponse` returns `null` on failure; the `?? {}` fallback means individual field checks will just skip everything.
4. **Write each field** (lines 38-107) — Three sequential writes, each with its own try/catch:
   - **Tags** always use `"append"` mode — new tags merge with existing ones, deduplicated
   - **Description** uses `resolveUpdateMethod` — `"update"` if force or empty, `"keep"` if preserving
   - **Title** additionally checks `enableTitle` and strips surrounding quotes

**Concern**: The three try/catch blocks are structurally identical (#67). Each catches a `updateFrontMatter` failure, shows a Notice, logs the error, and continues. If a fourth metadata field were added, this pattern should be extracted into a helper.

**Concern**: `hasChanges` tracking for description/title only counts `method === "update"` (lines 72, 98). When `method === "keep"`, the write is a no-op so `hasChanges` correctly stays false. But this subtlety is easy to misread.

---

## 6. Settings UI — `src/settingsTab.ts`

The settings tab renders Obsidian's native settings interface.

```bash
sed -n "1,48p" src/settingsTab.ts | cat -n
```

```output
     1	import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
     2	import type MetadataToolPlugin from "./main";
     3	
     4	export class MetadataToolSettingTab extends PluginSettingTab {
     5	  plugin: MetadataToolPlugin;
     6	
     7	  constructor(app: App, plugin: MetadataToolPlugin) {
     8	    super(app, plugin);
     9	    this.plugin = plugin;
    10	  }
    11	
    12	  display(): void {
    13	    const { containerEl } = this;
    14	    containerEl.empty();
    15	
    16	    // Anthropic API Settings
    17	    new Setting(containerEl).setName("Anthropic API Settings").setHeading();
    18	
    19	    new Setting(containerEl)
    20	      .setName("API Key")
    21	      .setDesc(
    22	        "Your Anthropic API key. Get one at console.anthropic.com (requires an account with billing enabled)",
    23	      )
    24	      .addText((text) => {
    25	        text
    26	          .setPlaceholder("sk-ant-...")
    27	          .setValue(this.plugin.settings.anthropicApiKey)
    28	          .onChange(async (value) => {
    29	            this.plugin.settings.anthropicApiKey = value;
    30	            await this.plugin.saveSettings();
    31	          });
    32	        text.inputEl.type = "password";
    33	      });
    34	
    35	    new Setting(containerEl)
    36	      .setName("Model")
    37	      .setDesc("Model to use for metadata generation")
    38	      .addDropdown((dropdown) =>
    39	        dropdown
    40	          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
    41	          .addOption("claude-opus-4-6", "Claude Opus 4.6")
    42	          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
    43	          .setValue(this.plugin.settings.anthropicModel)
    44	          .onChange(async (value) => {
    45	            this.plugin.settings.anthropicModel = value;
    46	            await this.plugin.saveSettings();
    47	          }),
    48	      );
```

The settings UI follows Obsidian's builder pattern — each `Setting` is constructed with a name, description, and input control. Key details:

- **API key** (line 32) — Input type is set to `password` *after* creation, masking the key in the UI. The value is still stored as plain text in the plugin's `data.json`.
- **Model dropdown** (lines 40-42) — Three options hardcoded. When Anthropic releases new models, this list needs a code change. The migration in `main.ts` handles the rename.
- **Every `onChange` saves immediately** (e.g., line 30) — Settings are persisted on every keystroke. No "save" button.

The remaining UI sections (truncation, tags, description, title) follow the same pattern. Notable interaction: the truncation toggle dynamically enables/disables the max tokens and method settings:

```bash
sed -n "71,122p" src/settingsTab.ts | cat -n
```

```output
     1	    new Setting(containerEl)
     2	      .setName("Truncate Content")
     3	      .setDesc("Limit content sent to API to reduce costs")
     4	      .addToggle((toggle) =>
     5	        toggle
     6	          .setValue(this.plugin.settings.truncateContent)
     7	          .onChange(async (value) => {
     8	            this.plugin.settings.truncateContent = value;
     9	            await this.plugin.saveSettings();
    10	            maxTokensSetting.setDisabled(!value);
    11	            truncateMethodSetting.setDisabled(!value);
    12	          }),
    13	      );
    14	
    15	    const maxTokensSetting = new Setting(containerEl)
    16	      .setName("Max Tokens")
    17	      .setDesc("Maximum content length in tokens")
    18	      .addText((text) =>
    19	        text
    20	          .setValue(this.plugin.settings.maxTokens.toString())
    21	          .onChange(async (value) => {
    22	            const parsed = Number.parseInt(value, 10);
    23	            if (Number.isNaN(parsed) || parsed < 1) {
    24	              new Notice("Max tokens must be a positive integer");
    25	              text.setValue(this.plugin.settings.maxTokens.toString());
    26	              return;
    27	            }
    28	            this.plugin.settings.maxTokens = parsed;
    29	            await this.plugin.saveSettings();
    30	          }),
    31	      );
    32	
    33	    const truncateMethodSetting = new Setting(containerEl)
    34	      .setName("Truncate Method")
    35	      .setDesc("How to truncate long content")
    36	      .addDropdown((dropdown) =>
    37	        dropdown
    38	          .addOption("head_only", "Beginning Only")
    39	          .addOption("head_tail", "Beginning + End")
    40	          .addOption("heading", "Headings + Summaries")
    41	          .setValue(this.plugin.settings.truncateMethod)
    42	          .onChange(async (value) => {
    43	            this.plugin.settings.truncateMethod = value as
    44	              | "head_only"
    45	              | "head_tail"
    46	              | "heading";
    47	            await this.plugin.saveSettings();
    48	          }),
    49	      );
    50	
    51	    maxTokensSetting.setDisabled(!this.plugin.settings.truncateContent);
    52	    truncateMethodSetting.setDisabled(!this.plugin.settings.truncateContent);
```

Lines 10-11 and 51-52 show the dynamic disable pattern. The toggle's `onChange` enables/disables the dependent settings. Lines 51-52 set the initial disabled state on page load. The same pattern is used for the title enable toggle and its field name/prompt settings.

**Input validation** (lines 22-26) — Max tokens must be a positive integer. Invalid input triggers a Notice and resets the input to the last valid value. This is the only validation in the UI — no tests cover it (#69).

**Concern**: No privacy notice in the API key section about content being sent to Anthropic (#62). Users configure their key without being informed about the data flow.

---

## 7. Build System

```bash
cat -n build.ts
```

```output
     1	const watch = process.argv.includes("--watch");
     2	
     3	const result = await Bun.build({
     4	  entrypoints: ["src/main.ts"],
     5	  outdir: ".",
     6	  format: "cjs",
     7	  external: ["obsidian", "electron"],
     8	  minify: !watch,
     9	});
    10	
    11	if (!result.success) {
    12	  console.error("Build failed");
    13	  for (const message of result.logs) console.error(message);
    14	  process.exit(1);
    15	}
    16	
    17	if (watch) console.log("Watching for changes...");
    18	
    19	export {};
```

Bun's native bundler produces a single `main.js` file in CommonJS format (line 6) — Obsidian requires CJS. Two externals (line 7): `obsidian` and `electron` are provided by the host runtime.

- **Dev mode** (`--watch`): No minification, faster iteration
- **Production**: Minified. The `build` npm script runs `check` (typecheck + biome) first, so `main.js` is only produced from clean code.

The `export {}` on line 19 makes the file a module (required for top-level await in Bun).

`main.js` is committed to the repo — Obsidian's plugin distribution requires it. This is unusual but standard for Obsidian plugins.

---

## 8. Validation and Versioning

```bash
cat -n scripts/validate-plugin.ts
```

```output
     1	#!/usr/bin/env bun
     2	
     3	import { readFileSync } from "node:fs";
     4	import { $ } from "bun";
     5	
     6	const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));
     7	console.log(`🔍 Validating ${manifest.name || "plugin"}...\n`);
     8	
     9	let errors = 0;
    10	
    11	// Check manifest.json
    12	if (!manifest.id || !manifest.name || !manifest.version) {
    13	  console.error("✗ manifest.json missing required fields");
    14	  errors++;
    15	} else {
    16	  console.log(`✓ manifest.json — ${manifest.name} v${manifest.version}`);
    17	}
    18	
    19	// Check package.json version matches manifest
    20	try {
    21	  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    22	  if (pkg.version !== manifest.version) {
    23	    console.error(
    24	      `✗ Version mismatch: package.json (${pkg.version}) != manifest.json (${manifest.version})`,
    25	    );
    26	    errors++;
    27	  } else {
    28	    console.log("✓ Version numbers match");
    29	  }
    30	} catch (error) {
    31	  console.error("✗ Version check failed:", error);
    32	  errors++;
    33	}
    34	
    35	// Run checks
    36	console.log("\n🔧 Checking code quality...");
    37	const checkResult = await $`bun run check`.nothrow();
    38	if (checkResult.exitCode === 0) {
    39	  console.log("✓ Code quality checks passed");
    40	} else {
    41	  console.error("✗ Code quality checks failed");
    42	  errors++;
    43	}
    44	
    45	// Build the plugin
    46	console.log("\n📦 Building plugin...");
    47	const buildResult = await $`bun run build.ts`.nothrow();
    48	if (buildResult.exitCode === 0) {
    49	  console.log("✓ Build successful");
    50	
    51	  const mainFile = Bun.file("main.js");
    52	  if (await mainFile.exists()) {
    53	    const size = mainFile.size / 1024;
    54	    console.log(`  Output: main.js (${size.toFixed(2)} KB)`);
    55	  } else {
    56	    console.error("✗ main.js not found after build");
    57	    errors++;
    58	  }
    59	} else {
    60	  console.error("✗ Build failed");
    61	  errors++;
    62	}
    63	
    64	// Summary
    65	console.log(`\n${"=".repeat(50)}`);
    66	if (errors === 0) {
    67	  console.log("✅ All validations passed! Plugin is ready.");
    68	  process.exit(0);
    69	} else {
    70	  console.log(`❌ Validation failed with ${errors} error(s).`);
    71	  process.exit(1);
    72	}
```

`validate-plugin.ts` is the pre-release gate. It checks four things in order:
1. `manifest.json` has required fields (id, name, version)
2. Version numbers match between `package.json` and `manifest.json`
3. `bun run check` passes (TypeScript + Biome)
4. Build succeeds and `main.js` exists

The `$.nothrow()` pattern (lines 37, 47) runs shell commands without throwing on non-zero exit, letting the script count errors and report them all.

```bash
cat -n version-bump.ts
```

```output
     1	import { readFileSync, writeFileSync } from "node:fs";
     2	
     3	const targetVersion = process.env.npm_package_version;
     4	if (!targetVersion) {
     5	  throw new Error("No version found in package.json");
     6	}
     7	
     8	// Update manifest.json
     9	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    10	const { minAppVersion } = manifest;
    11	manifest.version = targetVersion;
    12	writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    13	
    14	// Update versions.json
    15	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
    16	versions[targetVersion] = minAppVersion;
    17	writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
    18	
    19	console.log(`Updated to version ${targetVersion}`);
```

`version-bump.ts` syncs the version from `package.json` (via `npm_package_version` env var, set by `npm version`) into `manifest.json` and `versions.json`. The `versions.json` file maps plugin versions to minimum Obsidian versions — Obsidian uses this to warn users about compatibility.

---

## 9. Testing

Tests use Bun's built-in test runner with a preload file that mocks Obsidian's API:

```bash
cat -n src/test-preload.ts
```

```output
     1	import { mock } from "bun:test";
     2	
     3	mock.module("obsidian", () => ({
     4	  Plugin: class Plugin {},
     5	  Notice: class Notice {},
     6	  PluginSettingTab: class PluginSettingTab {},
     7	  Setting: class Setting {},
     8	}));
```

The preload mocks four Obsidian classes as empty stubs. This is sufficient because tests exercise pure logic (parsing, truncation, migration) rather than Obsidian integration.

### Test Coverage Summary

```bash
grep -c "it(" src/main.test.ts src/metadata.test.ts src/utils.test.ts
```

```output
src/main.test.ts:0
src/metadata.test.ts:0
src/utils.test.ts:0
```

```bash
grep -c "test(" src/main.test.ts src/metadata.test.ts src/utils.test.ts
```

```output
src/main.test.ts:10
src/metadata.test.ts:44
src/utils.test.ts:38
```

```bash
grep "describe(" src/main.test.ts src/metadata.test.ts src/utils.test.ts
```

```output
src/main.test.ts:describe("migrateSettings", () => {
src/metadata.test.ts:describe("parseMetadataResponse", () => {
src/metadata.test.ts:describe("parseTags", () => {
src/metadata.test.ts:describe("stripSurroundingQuotes", () => {
src/metadata.test.ts:describe("resolveUpdateMethod", () => {
src/metadata.test.ts:describe("isEmptyValue", () => {
src/metadata.test.ts:describe("buildPrompt", () => {
src/utils.test.ts:describe("splitIntoTokens", () => {
src/utils.test.ts:describe("joinTokens", () => {
src/utils.test.ts:describe("truncateHeadOnly", () => {
src/utils.test.ts:describe("truncateHeadTail", () => {
src/utils.test.ts:describe("truncateHeading", () => {
src/utils.test.ts:describe("updateFrontMatter", () => {
src/utils.test.ts:describe("getContent", () => {
```

92 tests across 14 describe blocks. Coverage is concentrated on pure functions:

| File | Tests | Covers |
|------|-------|--------|
| `main.test.ts` | 10 | Settings migration (all legacy value paths) |
| `metadata.test.ts` | 44 | Response parsing, tags, quotes, empty values, prompt building |
| `utils.test.ts` | 38 | Tokenization, all truncation methods, frontmatter writes, content extraction |

**Not tested** (identified concerns):
- `generateMetadata()` and `addMetadataWithClaude()` — the full orchestration flow (#63)
- `callClaude()` error handling paths (#66)
- `settingsTab.ts` — the entire UI module, including validation (#69)

The existing tests are thorough for what they cover. Edge cases like limit=1, empty input, CJK characters, and code fences in responses are all exercised.

---

## 10. Configuration Files

```bash
cat -n tsconfig.json
```

```output
     1	{
     2	  "compilerOptions": {
     3	    "target": "ESNext",
     4	    "lib": ["DOM", "ESNext"],
     5	    "module": "ESNext",
     6	    "moduleResolution": "bundler",
     7	    "noEmit": true,
     8	    "strict": true,
     9	    "skipLibCheck": true
    10	  },
    11	  "include": ["src/**/*.ts", "build.ts", "version-bump.ts"],
    12	  "exclude": ["src/**/*.test.ts"]
    13	}
```

```bash
cat -n biome.json
```

```output
     1	{
     2	  "$schema": "https://biomejs.dev/schemas/latest/schema.json",
     3	  "vcs": {
     4	    "enabled": true,
     5	    "clientKind": "git",
     6	    "useIgnoreFile": true
     7	  },
     8	  "files": {
     9	    "includes": [
    10	      "src/**/*.ts",
    11	      "src/**/*.js",
    12	      "*.json",
    13	      "scripts/**/*.ts",
    14	      "version-bump.ts",
    15	      "build.ts"
    16	    ],
    17	    "ignoreUnknown": true
    18	  },
    19	  "formatter": {
    20	    "indentStyle": "space"
    21	  },
    22	  "assist": {
    23	    "actions": {
    24	      "source": {
    25	        "organizeImports": "on"
    26	      }
    27	    }
    28	  }
    29	}
```

**TypeScript** — Strict mode enabled, `noEmit` (type checking only — Bun handles the actual build), `moduleResolution: "bundler"` matches Bun's resolution algorithm. `skipLibCheck` is standard for plugins that depend on Obsidian's types.

**Biome** — Replaces ESLint + Prettier with a single tool. VCS-aware (respects `.gitignore`), 2-space indent, auto-organizes imports. No custom lint rules are configured — Biome's defaults are used. This is a good practice: fewer custom rules means less configuration drift.

---

## 11. Concerns and Community Standards

### Adherence to Obsidian Plugin Guidelines

- **Plugin API usage** — Correctly uses `processFrontMatter` for frontmatter writes (not raw YAML manipulation). Uses `metadataCache` for reading.
- **Settings persistence** — Standard `loadData`/`saveData` pattern.
- **Command registration** — Single command with clear name.
- **No file system access outside Obsidian API** — All reads go through `app.vault.read()`.
- **`manifest.json`** — All required fields present. `isDesktopOnly: false` is appropriate since the plugin works on mobile (API calls work from any platform).

### Security

- **API key stored unencrypted** — Standard for Obsidian plugins (no secure storage API exists), but should be documented (#62).
- **`dangerouslyAllowBrowser: true`** — Justified and commented. Correct for Electron.
- **No content sanitization before API send** — Acceptable; Claude doesn't execute code, and the user controls what notes they run the command on.

### Code Quality

- **TypeScript strict mode** — Good.
- **Single production dependency** — Excellent. Minimal attack surface.
- **Biome enforcement** — Consistent formatting and import ordering.
- **Settings migration** — Forward-compatible; new settings get defaults automatically via `Object.assign`.

### Open Issues

Eight issues were filed from the guidelines assessment:

| # | Priority | Summary |
|---|----------|---------|
| #62 | HIGH | Privacy notice for API data flow |
| #63 | HIGH | Integration test for full command flow |
| #64 | MEDIUM | Debug logging toggle |
| #65 | MEDIUM | Token limit naming clarification |
| #66 | MEDIUM | Tests for callClaude error paths |
| #67 | LOW | Extract repeated try/catch pattern |
| #68 | LOW | Document token regex rationale |
| #69 | LOW | Settings tab validation tests |

No critical issues were found. The codebase is clean, well-structured, and follows Obsidian plugin conventions correctly.
