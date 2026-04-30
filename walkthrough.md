# Metadator Walkthrough

*2026-04-30T12:34:16Z by Showboat 0.6.1*
<!-- showboat-id: 18259526-9f3b-4235-976f-05f0ef44541e -->

## 1. Overview

Metadator is an Obsidian plugin that generates metadata — tags, a description,
and optionally a title — for the active note (or every `.md` descendant of a
folder) by sending its content to the Anthropic Claude API and writing the
model's structured tool-use response into the note's YAML frontmatter.

The codebase is TypeScript, built with Bun, bundled as CommonJS for Obsidian's
Electron renderer, and distributed as a single `main.js`. Runtime
dependencies: only `@anthropic-ai/sdk`.

```bash
cat manifest.json
```

```output
{
  "id": "metadator",
  "name": "Metadator",
  "version": "2.2.0",
  "minAppVersion": "1.4.0",
  "description": "Automatically generate metadata for your notes using AI",
  "author": "Mark Ayers",
  "authorUrl": "https://github.com/philoserf",
  "isDesktopOnly": false
}
```

The `id` is how Obsidian addresses the plugin in its registry. `minAppVersion`
gates the plugin on Obsidian's API surface. `isDesktopOnly` is false: the
plugin runs on mobile as well as desktop.

## 2. Project Layout

The source lives under `src/` with tests colocated next to the modules they
cover. Build tooling (`build.ts`, `version-bump.ts`, `deploy.ts`) is at the
root. `main.js` is committed because Obsidian plugin distribution ships the
built artifact, not the source.

```bash
find src -maxdepth 2 -type f -name '*.ts' | sort
```

```output
src/adapters/claude.ts
src/adapters/frontmatter.test.ts
src/adapters/frontmatter.ts
src/bulkConfirmModal.ts
src/bulkGenerate.test.ts
src/bulkGenerate.ts
src/bulkOrchestrator.ts
src/bulkProgressModal.ts
src/bulkSummaryModal.ts
src/callClaude.test.ts
src/content.test.ts
src/content/getContent.ts
src/content/tokens.ts
src/content/truncate.ts
src/content/types.ts
src/generateMetadata.test.ts
src/logger.test.ts
src/logger.ts
src/main.ts
src/metadata.test.ts
src/metadata.ts
src/settings.ts
src/settingsMigrate.test.ts
src/settingsMigrate.ts
src/settingsTab.test.ts
src/settingsTab.ts
src/test-preload.ts
```

The layout follows the architectural seam between business logic and
external concerns:

- **Top-level `src/`** — application code (entry, settings, single-note flow,
  bulk flow, logging).
- **`src/adapters/`** — anti-corruption layer over external SDKs. Only
  `claude.ts` may import `@anthropic-ai/sdk` (a Biome `noRestrictedImports`
  rule enforces it). `frontmatter.ts` wraps Obsidian's
  `app.fileManager.processFrontMatter`.
- **`src/content/`** — pure content extraction: tokenization, truncation
  strategies, and the `getContent` driver.

## 3. Plugin entry — `src/main.ts`

`MetadataToolPlugin` registers two user-visible affordances and owns the
plugin lifecycle: a single command for the active note, and a folder-menu
item for recursive runs. Both call paths share an `AbortController` so
unloading the plugin cancels in-flight work.

```bash
sed -n '1,55p' src/main.ts
```

```output
import { Notice, Plugin, TFolder } from "obsidian";
import { runBulkForFolder } from "./bulkOrchestrator";
import { generateMetadata } from "./metadata";
import { DEFAULT_SETTINGS, type MetadataToolSettings } from "./settings";
import { migrateSettings } from "./settingsMigrate";
import { MetadataToolSettingTab } from "./settingsTab";

export default class MetadataToolPlugin extends Plugin {
  settings: MetadataToolSettings = DEFAULT_SETTINGS;
  private runController: AbortController = new AbortController();
  // Set when data.json was written by a newer plugin version. While set,
  // saveSettings() refuses to write so we don't clobber forward-version
  // data with our defaults. Cleared by a successful (in-version) load.
  private futureSchemaBlocked = false;

  async onload(): Promise<void> {
    this.runController = new AbortController();
    await this.loadSettings();

    this.addCommand({
      id: "generate-metadata",
      name: "Generate metadata for current note",
      callback: async () => {
        await generateMetadata(this.app, this.settings, {
          signal: this.runController.signal,
        });
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, fileOrFolder) => {
        if (!(fileOrFolder instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("Generate metadata (recursive)")
            .setIcon("tags")
            .onClick(async () => {
              await runBulkForFolder(
                this.app,
                fileOrFolder,
                {
                  ...this.settings,
                },
                {
                  signal: this.runController.signal,
                },
              );
            }),
        );
      }),
    );

    this.addSettingTab(new MetadataToolSettingTab(this.app, this));
  }

```

The lifecycle is:

- `onload` resets the `runController`, loads (and possibly migrates) settings,
  registers the command and the folder file-menu, and mounts the settings tab.
- `onunload` aborts the controller — this propagates into the SDK call and
  any in-progress bulk run, which both honor the signal.
- `loadSettings` delegates to `migrateSettings` and then dispatches on the
  discriminated `MigrationResult`. A `future` result trips
  `futureSchemaBlocked`, which `saveSettings` checks before writing to avoid
  clobbering data written by a newer plugin version.

```bash
sed -n '56,89p' src/main.ts
```

```output
  onunload(): void {
    this.runController.abort("plugin_unloaded");
  }

  async loadSettings(): Promise<void> {
    const result = migrateSettings(await this.loadData());
    if (result.kind === "ok") {
      this.settings = { ...result.settings };
      this.futureSchemaBlocked = false;
    } else if (result.kind === "future") {
      this.settings = { ...DEFAULT_SETTINGS };
      this.futureSchemaBlocked = true;
      new Notice(
        `Metadator settings were written by a newer plugin version (schema v${result.loadedSchemaVersion}). Settings won't be saved until you upgrade the plugin to avoid corrupting your data.`,
        12000,
      );
    } else {
      this.settings = { ...DEFAULT_SETTINGS };
      this.futureSchemaBlocked = false;
    }
  }

  async saveSettings(): Promise<void> {
    if (this.futureSchemaBlocked) {
      new Notice(
        "Refusing to save: settings file is from a newer plugin version. Upgrade the plugin or delete data.json to proceed.",
        8000,
      );
      return;
    }
    await this.saveData(this.settings);
  }
}
```

## 4. Settings — `src/settings.ts`

Settings are a plain interface with strongly-typed enums for the model,
truncate method, and update method. `schemaVersion` is stamped on every
saved file; bumping `CURRENT_SCHEMA_VERSION` requires adding a matching
migration in the next module.

```bash
sed -n '1,40p' src/settings.ts
```

```output
import type { TruncateMethod } from "./content/types";

export const PROMPT_MAX_LENGTH = 1000;

// Bump CURRENT_SCHEMA_VERSION whenever a new migration is added to MIGRATIONS
// in main.ts. Each migration's key is the schema version it produces.
export const CURRENT_SCHEMA_VERSION = 1;

export interface MetadataToolSettings {
  schemaVersion: number;

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
  truncateMethod: TruncateMethod;

  // Update behavior
  updateMethod: "always_regenerate" | "preserve_existing";

  // Bulk-run safeguard: warn and require explicit override above this many
  // files-that-will-change. Tracks API-call count, not total candidates.
  maxBulkFiles: number;

  // Prompts
  tagsPrompt: string;
  descriptionPrompt: string;
  titlePrompt: string;
}
```

## 5. Settings migration — `src/settingsMigrate.ts`

Versioned migrations live in an ordered `MIGRATIONS` map keyed by the version
they produce. `applyMigrations` walks from the loaded version up to
`CURRENT_SCHEMA_VERSION`, throwing if any intermediate version is missing —
this catches the "bumped the constant without writing the migration" bug at
plugin-load time. After migrations run, every field is re-validated at the
trust boundary so a malformed `data.json` falls back to defaults instead of
poisoning later runs.

```bash
sed -n '56,108p' src/settingsMigrate.ts
```

```output
// Schema migrations, keyed by the version they produce. To add migration N,
// add an entry [N, fn] and bump CURRENT_SCHEMA_VERSION in settings.ts. Each
// migration mutates the raw bag in place; trust-boundary normalization runs
// afterward in migrateSettings.
const MIGRATIONS: ReadonlyMap<number, (s: Record<string, unknown>) => void> =
  new Map([
    [
      1,
      (s) => {
        // 0 → 1: rename retired model identifiers.
        if (s.anthropicModel === "claude-sonnet-4-5-20250929") {
          s.anthropicModel = "claude-sonnet-4-6";
        }
        if (s.anthropicModel === "claude-opus-4-5-20251101") {
          s.anthropicModel = "claude-opus-4-6";
        }
      },
    ],
  ]);

function readSchemaVersion(raw: Record<string, unknown>): number {
  return typeof raw.schemaVersion === "number" &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion >= 0
    ? raw.schemaVersion
    : 0;
}

export function applyMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  migrations: ReadonlyMap<
    number,
    (s: Record<string, unknown>) => void
  > = MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...raw };
  for (let v = fromVersion + 1; v <= targetVersion; v++) {
    const fn = migrations.get(v);
    if (!fn) {
      // A bumped CURRENT_SCHEMA_VERSION without a matching MIGRATIONS entry
      // would silently stamp the new version onto un-transformed data. Fail
      // loudly instead so the bug is caught at plugin-load time.
      throw new Error(
        `[Metadator] missing migration for schema version ${v}; bump CURRENT_SCHEMA_VERSION only after adding MIGRATIONS[${v}].`,
      );
    }
    fn(migrated);
  }
  migrated.schemaVersion = targetVersion;
  return migrated;
}
```

The discriminated `MigrationResult` is what lets `main.ts` distinguish a
fresh install (`missing`) from a forward-version `data.json` (`future`) and
refuse to overwrite the latter.

```bash
sed -n '110,135p' src/settingsMigrate.ts
```

```output
export type MigrationResult =
  | { kind: "ok"; settings: MetadataToolSettings }
  | { kind: "missing" }
  | { kind: "future"; loadedSchemaVersion: number };

export function migrateSettings(loaded: unknown | null): MigrationResult {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return { kind: "missing" };
  }

  const raw = loaded as Record<string, unknown>;
  const fromVersion = readSchemaVersion(raw);

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    console.warn(
      `[Metadator] data.json schemaVersion=${fromVersion} is newer than this plugin (${CURRENT_SCHEMA_VERSION}). Falling back to defaults to avoid corrupting your data.`,
    );
    return { kind: "future", loadedSchemaVersion: fromVersion };
  }

  const migrated = applyMigrations(raw, fromVersion);

  const anthropicModel = readString(
    migrated.anthropicModel,
    DEFAULT_SETTINGS.anthropicModel,
  );
```

## 6. Single-note flow — `src/metadata.ts`

The user-facing command path. `generateMetadata` validates the active file
and API key, then delegates to the worker `generateMetadataForFile`, which
returns a discriminated `FileResult` (`changed | skipped | error`). The
worker is also called by the bulk runner — sharing one body keeps the
single-note and bulk paths behavior-equivalent.

```bash
sed -n '154,203p' src/metadata.ts
```

```output
export async function generateMetadataForFile(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  opts: GenerateOptions = {},
): Promise<FileResult> {
  if (file.extension !== "md") {
    return { kind: "skipped", file, reason: "not a markdown file" };
  }

  if (!settings.anthropicApiKey) {
    return { kind: "skipped", file, reason: "missing API key" };
  }

  const fm = app.metadataCache.getFileCache(file);
  const frontMatter = fm?.frontmatter || {};

  if (!shouldGenerate(frontMatter, settings)) {
    return { kind: "skipped", file, reason: "all fields already populated" };
  }

  if (opts.signal?.aborted) {
    return { kind: "skipped", file, reason: "cancelled before request" };
  }

  try {
    const hasChanges = await addMetadataWithClaude(
      app,
      file,
      settings,
      frontMatter,
      writePolicyFromSettings(settings),
      opts.presentation ?? "interactive",
      opts.signal,
    );
    return hasChanges
      ? { kind: "changed", file }
      : { kind: "skipped", file, reason: "no changes" };
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) {
      return { kind: "skipped", file, reason: "cancelled" };
    }
    return {
      kind: "error",
      file,
      reason: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}
```

`addMetadataWithClaude` is the orchestration heart: extract content, build
the prompt, mint a `requestId` for log correlation, call the adapter, and
write each field through the frontmatter adapter. The `presentation`
parameter (`interactive | bulk`) controls notice display so bulk runs don't
flood the screen with one notice per file.

```bash
sed -n '252,322p' src/metadata.ts
```

```output
async function addMetadataWithClaude(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  frontMatter: Record<string, unknown>,
  policy: WritePolicy,
  presentation: PresentationMode,
  signal?: AbortSignal,
): Promise<boolean> {
  const isBulk = presentation === "bulk";
  const requestId = newRequestId();

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
    logDebug({
      event: "claude_request_start",
      file: file.path,
      model: settings.anthropicModel,
      requestId,
      promptLength: system.length,
      contentLength: userMessage.length,
    });
  }

  const notice = isBulk ? undefined : new Notice("Generating metadata...", 0);
  const startedAt = Date.now();
  let metadata: MetadataFields;
  try {
    metadata = await callClaudeForMetadata(system, userMessage, settings, {
      signal,
    });
  } catch (error) {
    if (settings.debugLogging) {
      logDebug({
        event: "claude_request_failed",
        file: file.path,
        model: settings.anthropicModel,
        requestId,
        durationMs: Date.now() - startedAt,
        errorKind: error instanceof ClaudeApiError ? error.kind : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    notice?.hide();
  }

  if (settings.debugLogging) {
    logDebug({
      event: "claude_request_completed",
      file: file.path,
      model: settings.anthropicModel,
      requestId,
      durationMs: Date.now() - startedAt,
    });
  }

  if (signal?.aborted) {
    return false;
  }
```

The prompt itself: the system message states the field requirements; the
user message wraps the (possibly truncated) note content in `<article>`
delimiters. The model is forced to call the `submit_metadata` tool, so the
response is structured input rather than free-form JSON to parse.

```bash
sed -n '49,80p' src/metadata.ts
```

```output
export interface PromptParts {
  system: string;
  userMessage: string;
}

export function buildPrompt(
  contentStr: string,
  settings: MetadataToolSettings,
): PromptParts {
  const systemParts = [
    "Generate metadata for the provided article and submit it via the submit_metadata tool. Field requirements:",
    "",
    `1. Tags: ${settings.tagsPrompt}`,
    "",
    `2. Description: ${settings.descriptionPrompt}`,
  ];

  if (settings.enableTitle) {
    systemParts.push("", `3. Title: ${settings.titlePrompt}`);
  }

  const userMessage = `<article>\n${contentStr}\n</article>`;

  return { system: systemParts.join("\n"), userMessage };
}

export function parseTags(tagsString: string): string[] {
  return tagsString
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}
```

## 7. Content extraction — `src/content/`

### 7.1 Tokenization — `tokens.ts`

The tokenizer approximates how an LLM tokenizer counts characters so the
truncation budget lines up. CJK ideographs and hiragana/katakana/hangul are
one token per character; everything else (Latin, Cyrillic, Greek, Hebrew,
Arabic, Devanagari, Thai…) is one token per word. The regex uses v-flag
set-subtraction to make the word match stop at script boundaries — with a
u-flag fallback for older mobile WebViews that don't support v-mode.

```bash
sed -n '14,32p' src/content/tokens.ts
```

```output
const CJK_FAMILY_RANGES = "一-龥぀-ヿ가-힯";

function buildTokenRegex(): RegExp {
  try {
    return new RegExp(
      `[一-龥]|[぀-ヿ]|[가-힯]|[[\\p{Letter}\\p{Number}]--[${CJK_FAMILY_RANGES}]][[\\p{Letter}\\p{Mark}\\p{Number}]--[${CJK_FAMILY_RANGES}]]*|[.,!?;，。！？；#]|\\n`,
      "gv",
    );
  } catch {
    return /[一-龥]|[぀-ヿ]|[가-힯]|[\p{Letter}\p{Number}][\p{Letter}\p{Mark}\p{Number}]*|[.,!?;，。！？；#]|\n/gu;
  }
}

const TOKEN_REGEX = buildTokenRegex();
const NON_SPACING_TOKEN = /^[一-龥぀-ヿ가-힯.,!?;，。！？；#]$/;

export function splitIntoTokens(str: string): string[] {
  return str.match(TOKEN_REGEX) ?? [];
}
```

### 7.2 Truncation strategies — `truncate.ts`

Three strategies share the same signature: `(tokens, limit) -> string`,
except `truncateHeading` which also needs the original content for line
parsing. `head_only` keeps the first N tokens; `head_tail` keeps 80% from
the start and the rest from the end with a `...` divider; `heading`
synthesizes an outline from `#`-prefixed lines plus a body of remaining
budget.

```bash
sed -n '1,21p' src/content/truncate.ts
```

```output
import { joinTokens, splitIntoTokens } from "./tokens";

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

```bash
sed -n '23,70p' src/content/truncate.ts
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

### 7.3 Driver — `getContent.ts`

`getContent` reads the file, tokenizes, and dispatches to the chosen
strategy. A negative `limit` short-circuits to the raw content (used by the
`truncateContent: false` path).

```bash
sed -n '10,40p' src/content/getContent.ts
```

```output
export async function getContent(
  app: App,
  file: TFile,
  limit: number = 1000,
  method: TruncateMethod = "head_only",
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

## 8. Adapters — `src/adapters/`

### 8.1 Anthropic SDK — `claude.ts`

The only module allowed to import `@anthropic-ai/sdk`. It builds a tool
schema from settings (title field is conditional), forces the model to call
`submit_metadata`, validates the returned input, and translates SDK errors
into a typed `ClaudeApiError` taxonomy (`auth | rate_limit | overloaded |
api | unknown`) so callers can branch without re-importing the SDK. The
adapter also threads `signal` through to the SDK and applies an explicit
60s timeout so a hung connection cannot block the command indefinitely.

```bash
sed -n '1,40p' src/adapters/claude.ts
```

```output
import Anthropic from "@anthropic-ai/sdk";
import type { MetadataToolSettings } from "../settings";

// Output budget for the model's tool-use response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;
const TOOL_NAME = "submit_metadata";

export type ClaudeErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "api"
  | "unknown";

export class ClaudeApiError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly retryAfterMs?: number;
  constructor(kind: ClaudeErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.name = "ClaudeApiError";
  }
}

export function parseRetryAfterMs(
  headers: { get?: (name: string) => string | null } | undefined,
): number | undefined {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // Retry-After may also be an HTTP-date; fall back to the computed delay
  // rather than parsing dates here.
  return undefined;
}
```

```bash
sed -n '163,219p' src/adapters/claude.ts
```

```output
export async function callClaudeForMetadata(
  system: string,
  userMessage: string,
  settings: MetadataToolSettings,
  options: CallClaudeOptions = {},
): Promise<MetadataFields> {
  // Allowing browser compatibility mode — safe within Obsidian's Electron-controlled environment under current use cases.
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  const tool = buildToolSchema(settings.enableTitle);

  let message: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    message = await anthropic.messages.create(
      {
        model: settings.anthropicModel,
        max_tokens: MAX_RESPONSE_TOKENS,
        system,
        messages: [{ role: "user", content: userMessage }],
        tools: [tool],
        tool_choice: { type: "tool", name: TOOL_NAME },
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        signal: options.signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw classifyError(error);
  }

  if (!Array.isArray(message.content)) {
    throw new ClaudeApiError("api", "Response had no content blocks");
  }
  const toolUses = message.content.filter((block) => block.type === "tool_use");
  const toolUse = toolUses.find(
    (block) => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (!toolUse || toolUse.type !== "tool_use") {
    if (toolUses.length > 0) {
      const names = toolUses
        .map((block) => (block.type === "tool_use" ? block.name : ""))
        .filter((n) => n !== "")
        .join(", ");
      throw new ClaudeApiError(
        "api",
        `Model called unexpected tool(s): ${names}`,
      );
    }
    throw new ClaudeApiError("api", "Model did not call the metadata tool");
  }
  return validateMetadataInput(toolUse.input, settings.enableTitle);
}
```

### 8.2 Frontmatter — `frontmatter.ts`

The frontmatter adapter wraps `app.fileManager.processFrontMatter` — the
only way to write frontmatter that survives Obsidian's reactive caching.
Three overloaded write modes encode the policy in the type system:
`append` (deduplicated set-merge for tags), `update` (assign for scalars),
and `keep` (write only if the field is missing). The adapter returns
whether the frontmatter actually changed so the success notice fires only
on real mutations.

```bash
sed -n '24,57p' src/adapters/frontmatter.ts
```

```output
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

## 9. Bulk run

### 9.1 Orchestration — `bulkOrchestrator.ts`

`runBulkForFolder` is the UI lifecycle: collect candidates, classify them
into willChange/willSkip without calling the API, show a confirm modal
(which hard-caps `willChange` against `settings.maxBulkFiles` with an
explicit override checkbox), then drive the engine with a progress modal
and produce a summary.

```bash
sed -n '13,79p' src/bulkOrchestrator.ts
```

```output
export async function runBulkForFolder(
  app: App,
  folder: TFolder,
  settings: MetadataToolSettings,
  opts: RunBulkForFolderOptions = {},
): Promise<void> {
  if (!settings.anthropicApiKey) {
    new Notice(
      "Please configure your Anthropic API key in Settings → Metadator",
      8000,
    );
    return;
  }

  const files = collectCandidates(folder);
  if (files.length === 0) {
    new Notice("No markdown files found in folder");
    return;
  }

  const { willChange, willSkip } = classifyCandidates(app, files, settings);
  if (willChange.length === 0) {
    new Notice(
      `All ${files.length} notes already have metadata; nothing to do`,
    );
    return;
  }

  const confirmed = await new BulkConfirmModal(app, {
    folderPath: folder.path,
    total: files.length,
    willChange: willChange.length,
    willSkip: willSkip.length,
    settings,
  }).openAndAwait();
  if (!confirmed) return;

  const progress = new BulkProgressModal(app);
  const runController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      runController.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener(
        "abort",
        () => runController.abort(opts.signal?.reason),
        { once: true },
      );
    }
  }
  progress.setAbortHandler(() => runController.abort("cancelled_by_user"));
  progress.open();

  const results = await runBulk(app, willChange, settings, {
    onProgress: (p) => progress.setProgress(p),
    shouldAbort: () => (opts.shouldAbort?.() ?? false) || progress.isAborted(),
    signal: runController.signal,
  });

  const aborted =
    progress.isAborted() ||
    (opts.shouldAbort?.() ?? false) ||
    runController.signal.aborted;
  progress.finish();

  new BulkSummaryModal(app, results, aborted, willChange.length).open();
}
```

### 9.2 Engine — `bulkGenerate.ts`

`collectCandidates` walks the folder tree, `classifyCandidates` runs
`shouldGenerate` for each file (no API calls — uses cached frontmatter),
and `runBulk` drives one file at a time through `runFileWithRetry`. The
retry policy retries on `rate_limit | overloaded` only, on the schedule
`[2s, 8s, 30s]` jittered to `[0.5x, 1.5x]`. If the SDK error carries a
`Retry-After` header, that value wins, capped at 2x the scheduled base
delay so a misbehaving header can't stall a long run.

```bash
sed -n '11,44p' src/bulkGenerate.ts
```

```output
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 8_000, 30_000,
];

export function collectCandidates(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  for (const child of folder.children) {
    if ("children" in child) {
      out.push(...collectCandidates(child as TFolder));
    } else {
      const file = child as TFile;
      if (file.extension === "md") out.push(file);
    }
  }
  return out;
}

export function classifyCandidates(
  app: App,
  files: TFile[],
  settings: MetadataToolSettings,
): { willChange: TFile[]; willSkip: TFile[] } {
  const willChange: TFile[] = [];
  const willSkip: TFile[] = [];
  for (const file of files) {
    const frontMatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    if (shouldGenerate(frontMatter, settings)) {
      willChange.push(file);
    } else {
      willSkip.push(file);
    }
  }
  return { willChange, willSkip };
}
```

```bash
sed -n '70,90p' src/bulkGenerate.ts
```

```output
const RETRY_AFTER_CAP_MULTIPLIER = 2;

export function computeDelayMs(
  baseDelayMs: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (
    error instanceof ClaudeApiError &&
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs)
  ) {
    return Math.min(
      error.retryAfterMs,
      baseDelayMs * RETRY_AFTER_CAP_MULTIPLIER,
    );
  }
  // Full jitter in [0.5x, 1.5x] of base — avoids synchronized retry storms
  // across parallel clients hitting a shared-tenant overload.
  return Math.round(baseDelayMs * (0.5 + random()));
}
```

The Cancel-during-backoff path: rather than `setTimeout(ms)`, the sleep
polls a `shouldAbort` callback every 100ms, so a Cancel that lands during
a 30s backoff is responsive to the user.

```bash
sed -n '92,108p' src/bulkGenerate.ts
```

```output
const ABORT_POLL_MS = 100;

async function sleepAbortable(
  ms: number,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  if (ms <= 0) return shouldAbort?.() ?? false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return true;
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(ABORT_POLL_MS, remaining)),
    );
  }
  return shouldAbort?.() ?? false;
}
```

## 10. Structured logging — `src/logger.ts`

When `debugLogging` is on, the request path emits structured records
(`event` + context drawn from `LogFields`) instead of free-form prose.
Vocabulary: `claude_request_start`, `claude_request_completed`,
`claude_request_failed` (per call), `claude_retry_scheduled` (bulk retry
loop), `frontmatter_write_failed`, `generation_failed`. Each record carries
a short hex `requestId` minted per `addMetadataWithClaude` invocation, so a
bulk retry produces a fresh requestId for each attempt while the file path
is the cross-attempt joiner.

`newRequestId` feature-detects the Web Crypto API: it prefers
`crypto.randomUUID`, falls back to `crypto.getRandomValues`, and finally to
`Math.random` so a missing API can never throw on the request path.

```bash
sed -n '8,33p' src/logger.ts
```

```output
export interface LogFields {
  event: string;
  file?: string;
  model?: string;
  requestId?: string;
  attempt?: number;
  durationMs?: number;
  errorKind?: string;
  errorMessage?: string;
  errorName?: string;
  errorStack?: string;
  field?: string;
  promptLength?: number;
  contentLength?: number;
}

const PREFIX = "[Metadator]";

export function logDebug(fields: LogFields): void {
  console.log(PREFIX, fields);
}

export function logError(fields: LogFields & { errorMessage: string }): void {
  console.error(PREFIX, fields);
}

```

```bash
sed -n '44,62p' src/logger.ts
```

```output
export function newRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID().slice(0, 8);
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(4);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  let fallback = "";
  for (let i = 0; i < 8; i++) {
    fallback += Math.floor(Math.random() * 16).toString(16);
  }
  return fallback;
}
```

## 11. Tests

Tests are colocated with their modules and run via Bun's native runner.
`src/test-preload.ts` mocks the Obsidian module surface — `Plugin`,
`Notice`, `Modal`, `TFolder`, `TFile`, etc. — so domain code can import
from `obsidian` without a real Electron environment.

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
  Modal: class Modal {
    app: unknown;
    contentEl = {
      empty() {},
      createEl() {
        return {};
      },
      createDiv() {
        return {};
      },
    };
    constructor(app: unknown) {
      this.app = app;
    }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
  },
  TFolder: class TFolder {},
  TFile: class TFile {},
}));
```

```bash
grep -c '^  it(\|^  test(' src/*.test.ts src/adapters/*.test.ts | sort
```

```output
src/adapters/frontmatter.test.ts:13
src/bulkGenerate.test.ts:30
src/callClaude.test.ts:25
src/content.test.ts:54
src/generateMetadata.test.ts:12
src/logger.test.ts:4
src/metadata.test.ts:11
src/settingsMigrate.test.ts:23
src/settingsTab.test.ts:7
```

A snapshot of the test surface as of this walkthrough — pure-helper
contracts, end-to-end flows through a fake `App`, the SDK adapter's error
taxonomy and Retry-After parsing, and the bulk engine's collect/classify/
runBulk plus `computeDelayMs` jitter.

## 12. Build and release

`build.ts` uses Bun's native bundler (CommonJS, externals: `obsidian`,
`electron`). Production builds are minified; dev builds are not.
`main.js` is committed because Obsidian distributes the built artifact.

The release flow: bump `package.json` → `bun run version` syncs
`manifest.json` and `versions.json` → `bun run build` → PR → merge → tag
on the merged commit → GitHub Actions creates the release.

