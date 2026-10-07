// Lightweight structured logging for the request path.
//
// Bulk runs interleave log lines from many files. A short per-file
// requestId plus a stable event vocabulary lets a reader scan the
// developer console and quickly pick out the lifecycle for any one
// file, including retries and failures.

// Every optional field accepts undefined: a record is built from values that
// may be unknown (an error without a stack), and an undefined field is simply
// not logged.
export interface LogFields {
  event: string;
  file?: string | undefined;
  model?: string | undefined;
  requestId?: string | undefined;
  attempt?: number | undefined;
  durationMs?: number | undefined;
  errorKind?: string | undefined;
  errorMessage?: string | undefined;
  errorName?: string | undefined;
  errorStack?: string | undefined;
  field?: string | undefined;
  promptLength?: number | undefined;
  contentLength?: number | undefined;
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
//
// That first sentence is why there is no Web Crypto ladder here. If
// collisions are acceptable, cryptographic randomness is not a
// requirement, and feature-detecting two APIs to reach it bought
// something this function had already declared it does not need.
//
// The id is also interpolated into the prompt delimiter as
// `article-${requestId}`, which is the one use that could want
// unpredictability — but that delimiter defends against a note
// *accidentally* closing the wrapper (#204), not against an adversary
// who can read the plugin's source and watch its output, and the note
// is the user's own in a single-user plugin.
//
// padEnd covers the rare short mantissa: Math.random() can yield fewer
// than 8 hex digits after the "0.".
export function newRequestId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}
