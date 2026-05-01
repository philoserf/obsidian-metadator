# Metadator Walkthrough

*2026-05-01T20:53:12Z by Showboat 0.6.1*
<!-- showboat-id: de0c1a9f-6b34-4660-818f-80b2196a1645 -->

## 1. Overview

Metadator is an Obsidian community plugin that asks Claude to characterize
a markdown note and writes the result — tags, description, optional
title — into the note's YAML frontmatter. It works on a single note (a
command in the command palette) or recursively on every `.md` file in a
folder (a context-menu action with a confirm/progress/summary flow).

The project is a TypeScript codebase bundled into a single `main.js` with
Bun. The SDK in use is `@anthropic-ai/sdk`. Tests run under `bun test`;
formatting and linting are owned by Biome; type-checking is `tsc --noEmit`.

The two manifests below are the public contract: Obsidian reads
`manifest.json` to load the plugin, and `package.json` declares the dev
toolchain and scripts.

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

```bash
sed -n '1,30p' package.json
```

```output
{
  "name": "metadator",
  "version": "2.2.0",
  "description": "Automatically generate metadata for Obsidian notes using AI",
  "main": "main.js",
  "author": "Mark Ayers",
  "license": "MIT",
  "scripts": {
    "audit": "bun audit --audit-level=critical",
    "dev": "bun run build.ts --watch",
    "build": "bun run check && bun run build.ts",
    "check": "bun run typecheck && biome check .",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "version": "bun run version-bump.ts",
    "test": "bun test",
    "deploy": "bun run deploy.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.13",
    "@types/bun": "^1.3.13",
    "@types/node": "^25.6.0",
    "obsidian": "^1.12.3",
    "typescript": "^6.0.3"
```

## 2. Architecture

Source lives entirely under `src/`. The bundled output `main.js` is
committed to the repo because Obsidian distributes the committed bundle.
Tests are colocated with their source.

The directory layout has three groups:

- **Top-level orchestration** — entry point, settings model, settings UI.
- **`src/adapters/`** — the only modules allowed to depend on external
  systems (the Anthropic SDK and Obsidian's `processFrontMatter`).
  A Biome rule enforces this for the SDK; the frontmatter adapter is
  conventional, not enforced.
- **`src/content/`** — pure utilities for tokenizing and truncating note
  content.

The flow has two entry points (single-note command and folder bulk run)
that both funnel through one pure worker — `generateMetadataForFile` —
which returns a discriminated `FileResult` union. Every caller speaks
that union and nothing else.

```bash
find src -type f -name '*.ts' ! -name '*.test.ts' ! -name 'test-preload.ts' | sort
```

```output
src/adapters/claude.ts
src/adapters/frontmatter.ts
src/bulkConfirmModal.ts
src/bulkGenerate.ts
src/bulkOrchestrator.ts
src/bulkProgressModal.ts
src/bulkSummaryModal.ts
src/content/getContent.ts
src/content/tokens.ts
src/content/truncate.ts
src/content/types.ts
src/logger.ts
src/main.ts
src/metadata.ts
src/settings.ts
src/settingsMigrate.ts
src/settingsTab.ts
```

## 3. Plugin entry — `src/main.ts`

`MetadataToolPlugin` extends Obsidian's `Plugin`. Three things happen in
`onload`:

1. A fresh `AbortController` is minted. Its signal is passed to every
   downstream call, so `onunload` can cancel anything in flight.
2. Settings are loaded through `migrateSettings`, which returns a
   discriminated `MigrationResult`. A `future` result (data written by a
   newer plugin version) sets `futureSchemaBlocked` and shows a Notice;
   `saveSettings` later refuses to overwrite the file in that state.
3. Two user-facing entry points are wired up: the
   `generate-metadata` command (single active note) and a `file-menu`
   listener that adds "Generate metadata (recursive)" to folder context
   menus.

```bash
sed -n '8,54p' src/main.ts
```

```output
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

A subtle detail: `runBulkForFolder` is invoked with `{ ...this.settings }`,
not `this.settings`. This freezes a snapshot at the moment the user
triggers the bulk run. If they open the Settings tab mid-run and change
the model, the in-flight batch ignores it. The single-note command
doesn't bother with this because it returns before the user can plausibly
re-enter Settings.

`loadSettings` and `saveSettings` are the seam between the migration
machinery and the rest of the plugin:

```bash
sed -n '60,87p' src/main.ts
```

```output
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
```

## 4. Settings model — `src/settings.ts`

The settings interface, default values, valid-option enums, and the
current schema version all live here. Any new persisted field added to
the plugin must thread through this file.

`CURRENT_SCHEMA_VERSION = 1` is the data-format version stamped onto
every saved `data.json`. Bumping it without adding a matching entry to
`MIGRATIONS` is caught by `applyMigrations` at load time (next section).

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

The comment on `CURRENT_SCHEMA_VERSION` says `MIGRATIONS` lives "in
main.ts" — that's stale; `MIGRATIONS` was extracted to
`settingsMigrate.ts` in commit `c950dac`. Flagged in Concerns below.

## 5. Settings migration — `src/settingsMigrate.ts`

`migrateSettings` is called once on plugin load. It returns a
`MigrationResult` discriminated union — `ok | missing | future` — and the
plugin entry branches on that. The "future" arm is the load-bearing one:
it prevents the plugin from clobbering forward-version data with its
defaults.

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

After migrations run, `migrateSettings` does trust-boundary normalization:
each field is read through `readString`/`readBoolean`/`readPositiveInt`
helpers that fall back to the default when the loaded value is wrong-typed
or out of range. This means a hand-edited `data.json` with garbage in any
field can't crash the plugin — at worst, that field reverts to default.

Notice the layered defense: migrations transform shape, then normalization
sanitizes types. They are cleanly separable; a future migration that
needs to look at the legacy raw bag still has it.

```bash
sed -n '110,150p' src/settingsMigrate.ts
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
  const truncateMethodCandidate = readString(
    migrated.truncateMethod,
    DEFAULT_SETTINGS.truncateMethod,
  );
  const updateMethodCandidate = readString(
    migrated.updateMethod,
    DEFAULT_SETTINGS.updateMethod,
  );

  const normalized: MetadataToolSettings = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    anthropicApiKey: readString(
      migrated.anthropicApiKey,
      DEFAULT_SETTINGS.anthropicApiKey,
    ),
```

## 6. Single-note flow — `src/metadata.ts`

`generateMetadata` (the command callback) is a thin wrapper around the
pure worker `generateMetadataForFile`. The wrapper resolves the active
file, validates that an API key is set, calls the worker, and translates
the worker's `FileResult` into Notice-driven UI.

The worker accepts an optional `presentation` mode (`"interactive" |
"bulk"`) and an `AbortSignal`. The same worker serves both the
single-note command and every per-file iteration of the bulk run.

`FileResult` is the central type. Every caller — single, bulk, or any
future entry point — speaks this union and nothing else.

```bash
sed -n '102,143p' src/metadata.ts
```

```output
export type WritePolicy = "update_all" | "only_empty";
export type PresentationMode = "interactive" | "bulk";

function writePolicyFromSettings(settings: MetadataToolSettings): WritePolicy {
  return settings.updateMethod === "always_regenerate"
    ? "update_all"
    : "only_empty";
}

function resolveUpdateMethod(
  policy: WritePolicy,
  currentValue: unknown,
): "update" | "keep" {
  if (policy === "update_all") return "update";
  return isEmptyValue(currentValue) ? "update" : "keep";
}

export function shouldGenerate(
  frontMatter: Record<string, unknown>,
  settings: MetadataToolSettings,
): boolean {
  if (settings.updateMethod === "always_regenerate") return true;
  return (
    isEmptyValue(frontMatter[settings.tagsFieldName]) ||
    isEmptyValue(frontMatter[settings.descriptionFieldName]) ||
    (settings.enableTitle && isEmptyValue(frontMatter[settings.titleFieldName]))
  );
}

export type FileResult =
  | { kind: "changed"; file: TFile }
  | { kind: "skipped"; file: TFile; reason: string }
  | { kind: "error"; file: TFile; reason: string; error: unknown };

export interface GenerateOptions {
  presentation?: PresentationMode;
  signal?: AbortSignal;
}

export interface InteractiveGenerateOptions {
  signal?: AbortSignal;
}
```

`shouldGenerate` is the predicate the bulk confirm modal uses to honestly
say "42 will change, 158 will skip" before any API call happens. Because
it is the same predicate the worker applies at run time, the prediction
and the action can't disagree. Breaking that equivalence would make the
confirmation modal lie to the user.

`writePolicy` and `resolveUpdateMethod` translate the user-facing setting
(`always_regenerate` / `preserve_existing`) into the per-field
write decision (`update` / `keep`). Tags get a third method — `append` —
selected later in `addMetadataWithClaude`.

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

The worker is the choke point: every reachable `kind: "error"` path goes
through one `try/catch`, and that catch demotes a known abort to
`skipped` rather than reporting it as an error. The bulk summary modal
relies on this distinction.

`addMetadataWithClaude` does the actual work. Three things to notice:

- The "Generating metadata…" Notice is suppressed in bulk mode (the
  progress modal covers it). The `isBulk` flag exists to gate that
  notice, the per-field write-failure notice, and the prompt-dump debug
  log — three small branches. A flag is usually a smell, but here it is
  small enough to read at a glance and avoids duplicating the entire
  function.
- A short hex `requestId` correlates every log line for one generation,
  so a debugger reading the console for a 500-file bulk run can trace
  one file's lifecycle.
- The function returns a boolean `hasChanges`. The caller decides
  `changed` vs `skipped:no changes` based on that. This is what makes
  the success Notice truthful when nothing actually changed (e.g. all
  proposed tags already existed).

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

The write loop assembles a list of `FieldUpdate` discriminated values —
tags use `append`, description and title use `update` — and sends each
through `writeField` with the resolved per-field method:

```bash
sed -n '326,402p' src/metadata.ts
```

```output
  type FieldUpdate =
    | { fieldName: string; value: string[]; updateMethod: "append" }
    | { fieldName: string; value: string; updateMethod: "update" };

  async function writeField(
    u: FieldUpdate,
    resolved: "update" | "keep",
  ): Promise<boolean> {
    try {
      if (resolved === "keep") {
        return await updateFrontMatter(app, file, u.fieldName, u.value, "keep");
      }
      if (u.updateMethod === "append") {
        return await updateFrontMatter(
          app,
          file,
          u.fieldName,
          u.value,
          "append",
        );
      }
      return await updateFrontMatter(app, file, u.fieldName, u.value, "update");
    } catch (error) {
      if (!isBulk) {
        new Notice(
          `Failed to write ${u.fieldName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      logError({
        event: "frontmatter_write_failed",
        file: file.path,
        requestId,
        field: u.fieldName,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        errorStack: error instanceof Error ? error.stack : undefined,
      });
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

  for (const u of updates) {
    if (signal?.aborted) {
      return hasChanges;
    }
    const resolved = resolveUpdateMethod(policy, frontMatter[u.fieldName]);
    if (await writeField(u, resolved)) {
      hasChanges = true;
    }
  }

  return hasChanges;
}
```

The `FieldUpdate` discriminated union is a small but pleasing piece of
TypeScript. By tying `value: string[]` to `updateMethod: "append"` and
`value: string` to `updateMethod: "update"`, the compiler refuses to let
you append a string or update with an array. The `updateFrontMatter`
adapter has overloaded signatures with the same shape — together, they
make the type-incompatible combinations unrepresentable.

## 7. Anthropic adapter — `src/adapters/claude.ts`

This is the only module in the codebase that imports `@anthropic-ai/sdk`.
Other modules consume the typed wrappers — `callClaudeForMetadata`,
`ClaudeApiError`, `MetadataFields` — so SDK types do not leak into the
rest of the code. The boundary is enforced by Biome (next snippet).

The adapter forces a single-tool response: the `submit_metadata` tool is
declared, `tool_choice` requires the model to call it, and the response
is parsed only as a `tool_use` block. Free-form prose responses are
rejected. This means there is no JSON-string parsing, no greedy regex,
no recovery layer — which is a major simplification compared to the
2.0-era prose-parsing strategy.

```bash
sed -n '17,40p' src/adapters/claude.ts
```

```output
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
sed -n '85,108p' src/adapters/claude.ts
```

```output
function classifyError(error: unknown): ClaudeApiError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ClaudeApiError("auth", error.message);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeApiError(
      "rate_limit",
      error.message,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ClaudeApiError(
      "overloaded",
      error.message,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeApiError("api", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ClaudeApiError("unknown", message);
}
```

SDK exception types are mapped to a five-arm error taxonomy
(`auth | rate_limit | overloaded | api | unknown`) so the rest of the
codebase never imports SDK error classes. `bulkGenerate.ts` consumes only
this taxonomy — `isRateLimitOrOverload` looks at `kind`, not at SDK class
identity — which is what makes a provider switch a one-module change.

The actual API call happens here. Note `tool_choice: { type: "tool",
name: TOOL_NAME }` — the model is forced to call `submit_metadata`, not
respond freely. Validation is deferred to `validateMetadataInput`, which
type-checks each field of the tool's input.

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

The SDK boundary is enforced — not by social convention, but by Biome's
`noRestrictedImports` rule:

```bash
sed -n '30,57p' biome.json
```

```output
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "@anthropic-ai/sdk": "Import @anthropic-ai/sdk only from src/adapters/claude.ts. Other modules should depend on the adapter's typed wrapper (callClaudeForMetadata, ClaudeApiError) so SDK types do not leak into application or domain code."
            }
          }
        }
      }
    }
  },
  "overrides": [
    {
      "includes": ["src/adapters/claude.ts", "**/*.test.ts"],
      "linter": {
        "rules": {
          "style": {
            "noRestrictedImports": "off"
          }
        }
      }
    }
  ]
```

The override makes the adapter and the test files exempt — tests need
the SDK module name to mock it, and the adapter is the one place the
import is intentional.

## 8. Frontmatter adapter — `src/adapters/frontmatter.ts`

`updateFrontMatter` delegates to Obsidian's `processFrontMatter` — the
only sanctioned way to mutate YAML frontmatter atomically. The plugin
never parses or serializes YAML itself; the adapter's job is just to
encode the three semantic operations the rest of the code wants to
perform.

The TypeScript overloads make the value/method combinations type-safe:
`append` requires `string[]`, `update` accepts `string | boolean`,
`keep` accepts any of them.

```bash
cat src/adapters/frontmatter.ts
```

```output
import type { App, TFile } from "obsidian";

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

The boolean return value is what makes "no-op write" distinguishable
from "real change". If a regenerated tag set is identical to the
existing one, `changed` stays false; the caller sees `hasChanges:
false`, and the user gets `skipped: no changes` instead of a misleading
"Metadata updated successfully" notice.

## 9. Content extraction & truncation — `src/content/`

Long notes need to be truncated before being sent to Claude, both for
cost and for the model's input window. Truncation is heuristic — the
plugin's tokenizer is not Claude's actual tokenizer — but it's
conservative enough to stay within budget.

`splitIntoTokens` uses the Unicode v-flag set-subtraction syntax to
tokenize CJK characters per-character and Latin/etc. as whole words. A
try/catch falls back to a u-flag regex on older mobile WebViews that
don't support v-flag; this is the only place in the codebase that
explicitly handles older WebView quirks.

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

`getContent` reads the file, tokenizes, and dispatches on the configured
method. `head_only` keeps the first N tokens. `head_tail` keeps an
80%/20% split. `heading` reconstructs an outline from `#`-prefixed
lines plus a one-line summary of each section's first paragraph.

```bash
sed -n '10,39p' src/content/getContent.ts
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

## 10. Logger — `src/logger.ts`

Structured logs are emitted only when `settings.debugLogging` is on. The
log payload is a flat record with an `event` discriminator plus optional
context (`file`, `model`, `requestId`, `attempt`, `durationMs`,
`errorKind`, etc.). Picking apart a 500-file bulk run from the developer
console is then a matter of grepping by `requestId` or `file`.

The event vocabulary is small and stable: `claude_request_start`,
`claude_request_completed`, `claude_request_failed`,
`claude_retry_scheduled`, `frontmatter_write_failed`,
`generation_failed`.

`newRequestId` mints a short hex id with three layers of feature
detection — `crypto.randomUUID`, `crypto.getRandomValues`, and a
`Math.random` fallback — so the request path can never throw on a
missing API.

```bash
sed -n '8,32p' src/logger.ts
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
sed -n '44,61p' src/logger.ts
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

## 11. Bulk flow — `src/bulkOrchestrator.ts` + `src/bulkGenerate.ts`

The bulk run has two layers. The orchestrator owns the dependencies on
`Modal` and on the generation engine, sequencing them. The engine
(`bulkGenerate.ts`) has zero UI imports — it is unit-testable purely by
passing fake `onProgress` and `shouldAbort` callbacks. Don't import
`Modal` into `bulkGenerate.ts`; that would collapse the seam.

The orchestrator runs four phases:

1. Collect candidates (every `.md` under the folder, recursively).
2. Classify them with the same `shouldGenerate` predicate the worker
   uses — this is what makes the confirm modal honest.
3. Open the confirm modal; if the user cancels, return.
4. Open the progress modal, run `runBulk`, then open the summary modal.

Cancellation flows through an `AbortController` that fans out to: the
progress modal's Cancel button, the parent plugin's lifetime signal,
and any caller-supplied `shouldAbort` predicate.

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

The engine handles retry, jitter, and abort polling. The retry policy is
two pieces: a small `[2s, 8s, 30s]` schedule (`DEFAULT_RETRY_DELAYS_MS`)
and a `computeDelayMs` function that adds full jitter (`[0.5x, 1.5x]`)
or, if the SDK error came with a `Retry-After` header, honors that —
capped at 2x the scheduled base so a misbehaving header can't stall a
long bulk run.

```bash
sed -n '61,108p' src/bulkGenerate.ts
```

```output
function isRateLimitOrOverload(error: unknown): boolean {
  return (
    error instanceof ClaudeApiError &&
    (error.kind === "rate_limit" || error.kind === "overloaded")
  );
}

// Cap server-provided Retry-After at this multiple of the scheduled base
// delay so a misbehaving header can't stall a long bulk run indefinitely.
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

`sleepAbortable` polls every 100ms — a hundred-note batch on the 30s
backoff slot has to remain responsive to the user's Cancel button. The
`random` injection point on `computeDelayMs` is the seam tests use to
verify jitter math without a non-deterministic clock.

The retry loop calls the worker and only retries on
`isRateLimitOrOverload`. Other error kinds (`auth`, `api`, `unknown`)
fall through to the result and become a row in the summary modal.

```bash
sed -n '110,153p' src/bulkGenerate.ts
```

```output
async function runFileWithRetry(
  app: App,
  file: TFile,
  settings: MetadataToolSettings,
  retryDelaysMs: readonly number[],
  shouldAbort?: () => boolean,
  signal?: AbortSignal,
  random: () => number = Math.random,
): Promise<FileResult> {
  const shouldStop = () =>
    (shouldAbort?.() ?? false) || (signal?.aborted ?? false);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (shouldStop()) {
      return { kind: "skipped", file, reason: "cancelled before attempt" };
    }
    const r = await generateMetadataForFile(app, file, settings, {
      presentation: "bulk",
      signal,
    });
    if (r.kind !== "error" || !isRateLimitOrOverload(r.error)) return r;
    if (attempt === retryDelaysMs.length) return r;
    const delayMs = computeDelayMs(retryDelaysMs[attempt], r.error, random);
    if (settings.debugLogging) {
      logDebug({
        event: "claude_retry_scheduled",
        file: file.path,
        attempt: attempt + 1,
        durationMs: delayMs,
        errorKind: r.error instanceof ClaudeApiError ? r.error.kind : "unknown",
      });
    }
    const aborted = await sleepAbortable(delayMs, shouldStop);
    if (aborted) {
      return {
        kind: "skipped",
        file,
        reason: "cancelled during retry backoff",
      };
    }
  }
  // Unreachable — loop always returns.
  return { kind: "skipped", file, reason: "retry loop exited unexpectedly" };
}
```

## 12. Modals — confirm, progress, summary

Three modals form the bulk-run lifecycle. Each one carefully separates
"resolve" (the contract) from "close" (the DOM event):

- **Confirm modal**: `openAndAwait` returns a Promise. Both Cancel and
  the X/Escape route resolve to `false`. A private `resolve` helper
  guards against double-resolution.
- **Progress modal**: distinguishes `finish()` (orchestrator-driven
  happy path) from `close()` (user-driven, treated as abort). The
  `finishing` flag is the lock that prevents double-counting.
- **Summary modal**: pure presentation; reads `FileResult` and renders
  changed/skipped/errored counts plus a list of error rows.

The progress modal's distinction is the one most prone to bugs. Conflate
"the orchestrator told me we're done" with "the user closed me", and
either every successful run looks like an abort, or every abort looks
like a normal finish.

```bash
sed -n '37,55p' src/bulkProgressModal.ts
```

```output
  isAborted(): boolean {
    return this.aborted;
  }

  // Orchestrator calls finish() after the run completes normally. Direct
  // close() (or Esc) leaves finishing=false, so onClose treats it as abort.
  finish(): void {
    this.finishing = true;
    this.close();
  }

  onClose(): void {
    if (!this.finishing) {
      this.aborted = true;
      this.onAbort?.();
    }
    this.contentEl.empty();
  }
}
```

## 13. Concerns

### Code quality

1. **Stale comment in `src/settings.ts`.** The doc-comment on
   `CURRENT_SCHEMA_VERSION` says `MIGRATIONS` lives "in main.ts", but
   the map was extracted to `src/settingsMigrate.ts` in commit
   `c950dac`. Low-impact but misleading for new readers.

2. **`runFileWithRetry`'s "unreachable" return.** The trailing
   `return { kind: "skipped", ... reason: "retry loop exited
   unexpectedly" }` is structurally unreachable — every iteration
   returns or breaks. TypeScript's flow analysis can't see that, so the
   line stays. It's defensible, but a `// biome-ignore` plus a typed
   `never`-arm `throw` would be more truthful about the invariant.

3. **`bulkConfirmModal.ts` mutates `style` directly.** Setting
   `warn.style.color = "var(--text-warning)"` works but bakes presentation
   into TypeScript. If this plugin were ever to ship `styles.css`
   (a community-directory requirement), these inline styles should
   migrate to CSS classes. See "Community standards" below.

4. **`isAbortError` is duplicated.** Both `metadata.ts` and
   `adapters/claude.ts` define identical `isAbortError(error)`
   helpers. Extracting to a shared utility is a one-line change with
   no behavioral risk.

5. **`enableTitle: false` still pays for title generation.** Even when
   the setting is off, `addMetadataWithClaude` always asks Claude for
   tags + description (and title only if enabled). Under
   `preserve_existing` with two of three fields populated, all three
   are still requested. This is a deliberate trade-off — simpler prompt
   construction at the cost of wasted output tokens — but it's worth
   revisiting if the plugin is run frequently on partially-tagged
   notes.

### Community standards

1. **No `styles.css`.** The Obsidian community plugin guidelines
   recommend shipping a `styles.css` even if empty, so downstream
   tooling has a stable manifest. This plugin uses inline `style.X = Y`
   assignments in modals (item 3 above). If the plugin is submitted to
   the community directory, this needs addressing.

2. **`isDesktopOnly: false` is unverified on mobile.** The manifest
   claims mobile support, but the bulk flow has never been exercised
   on Obsidian Mobile, where the Anthropic SDK's
   `dangerouslyAllowBrowser: true` runs in a real mobile WebView (not
   Electron). Long-running batches on iOS are at the mercy of OS
   backgrounding; there is no defensive guard.

3. **Canvas / Excalidraw notes are stored as `.md`.**
   `collectCandidates` filters by `extension === "md"` and pulls them
   in. Their bodies are JSON, not prose. Sending them to Claude is
   wasteful and pollutes their frontmatter — a user with a
   canvas-heavy folder will quietly burn API credits. The PRD
   deferred this; flagging it again as a remaining footgun.

### Risks

1. **`dangerouslyAllowBrowser: true` plus an API key in plaintext.**
   The Anthropic SDK is invoked from the renderer process with the
   user's key in memory; Obsidian's plugin storage writes the key to
   `data.json` in plaintext (no encrypted-storage API exists). This
   is documented in the README's privacy section, but the README
   should also explicitly warn users not to commit `data.json`.

2. **`heading` truncation's body offset.** The `bodyStart` index is
   computed against the original token stream while `outlineTokens`
   measures the reconstructed outline. The reconstructed outline can
   compress paragraphs (the truncated 30-token summary of each), so
   `bodyStart` may not point exactly at "content not yet covered by
   the outline". In practice the body section can skip or repeat
   content for documents with many headings. The unit tests cover
   "body doesn't start with `#`" but not positional correctness.

3. **No bulk-run cap on output cost.** `maxBulkFiles` caps
   files-that-will-change (i.e. API-call count), but there is no cap
   on tokens-per-call. A user pointing the plugin at a folder of
   long notes pays for `MAX_RESPONSE_TOKENS = 2048` per file;
   500 files at 2048 output tokens is non-trivial money on a paid
   tier. A "predicted total tokens" line in the confirm modal would
   help.

---

The single most load-bearing idea: every entry point speaks `FileResult`,
the worker is pure, and the modals are the only place UI lives. Edits
that respect that line — adding a new entry point, adding a new error
kind, swapping the LLM provider — land cleanly. Edits that collapse it
— putting UI in the worker, putting generation in a modal, bypassing
`FileResult` with ad-hoc returns — silently damage the architecture.

