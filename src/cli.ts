import {
  type App,
  type CliData,
  getFrontMatterInfo,
  parseYaml,
  type TFile,
} from "obsidian";
import { type FileResult, generateMetadataForFile } from "./metadata";
import type { MetadataConfig } from "./settings";

interface Fields {
  title?: unknown;
  description?: unknown;
  tags?: unknown;
}

// What `obsidian metadator:generate` prints: one JSON object, so a skill can
// parse the outcome instead of scraping a sentence. `reason` on a skip is the
// closed SkipReason union and safe to match; on an error it is prose, for
// display only.
export type CliOutput =
  | ({ status: "changed" | "skipped"; file: string; reason?: string } & Fields)
  | { status: "error"; file?: string; reason: string };

// The CLI is a third entry point beside the command and the folder run, and
// like them it renders a FileResult rather than deciding anything: the key check, the
// lock and the write policies are all generateMetadataForFile's. It never
// throws — Obsidian prints whatever string comes back, and a thrown error
// would reach the automation as nothing at all.
export async function generateForPath(
  app: App,
  settings: MetadataConfig,
  params: CliData,
  signal?: AbortSignal,
): Promise<string> {
  return JSON.stringify(await run(app, settings, params, signal));
}

async function run(
  app: App,
  settings: MetadataConfig,
  params: CliData,
  signal?: AbortSignal,
): Promise<CliOutput> {
  const path = params.path;
  if (!path || path === "true") {
    return { status: "error", reason: "path=<vault path> is required" };
  }
  const file = app.vault.getFileByPath(path);
  if (!file) {
    return { status: "error", file: path, reason: "no such file" };
  }

  try {
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

// Read back from disk, not from what the pipeline sent: under `merge` and
// `preserve` the note holds something other than the model's answer, and the
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
  return {
    title: fm[settings.titleFieldName],
    description: fm[settings.descriptionFieldName],
    tags: fm[settings.tagsFieldName],
  };
}
