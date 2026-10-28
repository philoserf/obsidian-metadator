import {
  type App,
  type CliData,
  getFrontMatterInfo,
  parseYaml,
  type TFile,
} from "obsidian";
import { newRequestId } from "./logger";
import {
  type FileResult,
  generateMetadataForFile,
  type Proposed,
  skipBeforeCall,
} from "./metadata";
import {
  anyFieldEnabled,
  FIELD_NAME_KEY,
  METADATA_FIELDS,
  type MetadataConfig,
  type MetadataField,
  NO_FIELDS_ENABLED_MESSAGE,
} from "./settings";

type Fields = Partial<Record<MetadataField, unknown>>;

// What `obsidian metadator:generate` prints: one JSON object, so a skill can
// parse the outcome instead of scraping a sentence. `reason` on a skip is the
// closed SkipReason union and safe to match; on an error it is prose, for
// display only. A `preview` (from `dry-run`) carries only the fields the run
// would write, with the values it would write; nothing was written.
export type CliOutput =
  | ({ status: "changed" | "skipped"; file: string; reason?: string } & Fields)
  | ({ status: "preview"; file: string } & Proposed)
  | { status: "error"; file?: string; reason: string };

// The Obsidian CLI stops waiting for a handler after roughly 10-20 ms and
// prints nothing, while the handler finishes in the background (#323). A
// generation takes seconds, so `metadator:generate` answers at once: with its
// final JSON when it can tell without a network call, otherwise with
// `{status: "started", id}`. `metadator:result id=` then prints what
// generate returned. Runs live in memory only, so nothing syncs.
export type StartOutput =
  | CliOutput
  | { status: "started"; id: string; file: string };
export type ResultOutput =
  | (CliOutput & { id: string })
  | { status: "running"; id: string }
  | { status: "error"; reason: string };

// Enough for a batch of CLI calls to be read back, small enough that a session
// of them cannot grow without bound. The oldest is dropped first.
export const MAX_CLI_RUNS = 50;

export class CliRuns {
  private readonly runs = new Map<string, CliOutput | "running">();

  start(id: string, work: Promise<CliOutput>): void {
    this.runs.set(id, "running");
    while (this.runs.size > MAX_CLI_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
    // generate() never rejects. An evicted run stays evicted.
    void work.then((output) => {
      if (this.runs.has(id)) this.runs.set(id, output);
    });
  }

  read(id: string): CliOutput | "running" | undefined {
    return this.runs.get(id);
  }
}

export function startGenerate(
  app: App,
  settings: MetadataConfig,
  params: CliData,
  runs: CliRuns,
  signal?: AbortSignal,
): string {
  const target = resolveTarget(app, settings, params);
  if (!target.ok) return JSON.stringify(target.out);
  const { file } = target;
  const skip = skipBeforeCall(app, file, settings, signal);
  if (skip) {
    // Nothing was written, so the cache is as current as the disk, and
    // reading it keeps this answer synchronous. A dry run's skip carries no
    // fields, as generate's does not.
    const out: CliOutput = {
      status: "skipped",
      file: file.path,
      reason: skip,
      ...(params["dry-run"] === "true"
        ? {}
        : cachedFields(app, file, settings)),
    };
    return JSON.stringify(out);
  }
  const id = newRequestId();
  runs.start(id, generate(app, settings, params, signal));
  const started: StartOutput = { status: "started", id, file: file.path };
  return JSON.stringify(started);
}

export function readResult(params: CliData, runs: CliRuns): string {
  const id = params.id;
  let out: ResultOutput;
  if (!id || id === "true") {
    out = { status: "error", reason: "id=<run id> is required" };
  } else {
    const state = runs.read(id);
    out =
      state === undefined
        ? { status: "error", reason: `no run ${id}` }
        : state === "running"
          ? { status: "running", id }
          : { ...state, id };
  }
  return JSON.stringify(out);
}

// The checks that need no file contents: fields switched on, a path given, a
// file at it. Returns the file, or the error to print.
function resolveTarget(
  app: App,
  settings: MetadataConfig,
  params: CliData,
): { ok: true; file: TFile } | { ok: false; out: CliOutput } {
  // An error, not a skip: nothing about the file was consulted, and a skill
  // driving the CLI should stop rather than move on to the next path (#305).
  if (!anyFieldEnabled(settings)) {
    return {
      ok: false,
      out: { status: "error", reason: NO_FIELDS_ENABLED_MESSAGE },
    };
  }
  const path = params.path;
  if (!path || path === "true") {
    return {
      ok: false,
      out: { status: "error", reason: "path=<vault path> is required" },
    };
  }
  const file = app.vault.getFileByPath(path);
  if (!file) {
    return {
      ok: false,
      out: { status: "error", file: path, reason: "no such file" },
    };
  }
  return { ok: true, file };
}

// One CLI run to its outcome. The CLI is the second entry point beside the
// command, and like it renders a FileResult rather than deciding anything:
// the key check, the lock and the write policies are all
// generateMetadataForFile's. It never rejects — a rejection would leave the
// run "running" forever in CliRuns.
export async function generate(
  app: App,
  settings: MetadataConfig,
  params: CliData,
  signal?: AbortSignal,
): Promise<CliOutput> {
  const target = resolveTarget(app, settings, params);
  if (!target.ok) return target.out;
  const { file } = target;
  const path = file.path;

  try {
    // A boolean flag arrives as "true" when given.
    if (params["dry-run"] === "true") {
      const preview = await generateMetadataForFile(app, file, settings, {
        signal,
        dryRun: true,
      });
      if (preview.kind === "error") {
        return { status: "error", file: path, reason: preview.reason };
      }
      if (preview.kind === "skipped") {
        return { status: "skipped", file: path, reason: preview.reason };
      }
      return { status: "preview", file: path, ...preview.proposed };
    }
    const result = await generateMetadataForFile(app, file, settings, {
      signal,
    });
    if (result.kind === "error") {
      return { status: "error", file: path, reason: result.reason };
    }
    return {
      status: result.kind,
      file: path,
      ...skipReason(result),
      ...(await readFields(app, file, settings)),
    };
  } catch (error) {
    return {
      status: "error",
      file: path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function skipReason(result: FileResult): { reason?: string } {
  return result.kind === "skipped" ? { reason: result.reason } : {};
}

function fieldsFrom(
  fm: Record<string, unknown>,
  settings: MetadataConfig,
): Fields {
  return Object.fromEntries(
    METADATA_FIELDS.map((field) => [
      field,
      fm[settings[FIELD_NAME_KEY[field]]],
    ]),
  );
}

function cachedFields(app: App, file: TFile, settings: MetadataConfig): Fields {
  if (file.extension !== "md") return {};
  return fieldsFrom(
    app.metadataCache.getFileCache(file)?.frontmatter ?? {},
    settings,
  );
}

// Read back from disk, not from what the pipeline sent: under `preserve` the
// note holds something other than the model's answer, and the
// metadata cache lags a write that has just landed. Reading the file is the
// one source that cannot disagree with the note.
async function readFields(
  app: App,
  file: TFile,
  settings: MetadataConfig,
): Promise<Fields> {
  if (file.extension !== "md") return {};
  const info = getFrontMatterInfo(await app.vault.read(file));
  const fm: Record<string, unknown> = info.exists
    ? (parseYaml(info.frontmatter) ?? {})
    : {};
  return fieldsFrom(fm, settings);
}
