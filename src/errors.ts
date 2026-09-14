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

// A frontmatter write that threw, carrying which fields failed. Modelled the
// way the SDK's failures already are — a class the renderers can `instanceof`
// — because the alternative is matching on the prose in FileResult.reason,
// which is the exact thing SkipReason exists to stop (#234). "Not a
// ClaudeApiError, therefore a write failure" is not safe either: a cachedRead
// that throws inside getContent lands in the same catch and would be
// mislabelled the other way.
export class FrontmatterWriteError extends Error {
  readonly fields: string[];
  override readonly cause: unknown;

  constructor(fields: string[], cause: unknown) {
    super(`failed to write frontmatter: ${fields.join(", ")}`);
    this.name = "FrontmatterWriteError";
    this.fields = fields;
    this.cause = cause;
  }
}
