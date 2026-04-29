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

// Short hex correlation id; collisions are acceptable since the file
// path and event still disambiguate, and short ids stay readable in
// console output.
//
// Feature-detect the Web Crypto API: Obsidian Desktop and modern
// mobile WebViews ship `crypto.randomUUID`, but older mobile WebViews
// may only expose `crypto.getRandomValues`. Fall back to Math.random
// as a last resort so a missing API can never throw on the request
// path (newRequestId is called for every metadata generation, not
// only when debug logging is on).
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
