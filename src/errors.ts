// Abort signalling is not uniform across runtimes: fetch in Obsidian's Electron
// renderer rejects with a DOMException named "AbortError", while the SDK and
// some polyfills throw a plain Error with the same name. Both request paths
// (metadata.ts and the Claude adapter) need the same answer, so there is one
// definition rather than two that can drift apart.
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}
