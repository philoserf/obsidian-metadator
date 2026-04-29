// Lightweight structured logging for the request path.
//
// Bulk runs interleave log lines from many files. A short per-file
// requestId plus a stable event vocabulary lets a reader scan the
// developer console and quickly pick out the lifecycle for any one
// file, including retries and failures.

export interface LogFields {
  event: string;
  file?: string;
  model?: string;
  requestId?: string;
  attempt?: number;
  durationMs?: number;
  errorKind?: string;
  errorMessage?: string;
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

// Short hex correlation id; collisions are acceptable since the file
// path and event still disambiguate, and short ids stay readable in
// console output.
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
