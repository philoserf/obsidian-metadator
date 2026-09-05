// Files currently being generated, by path.
//
// Two flows reach generateMetadataForFile — the single-note command and the
// recursive folder run — and nothing stopped them overlapping on one file.
// Each invocation snapshots frontmatter before a multi-second API call and
// then decides per-field update-vs-keep from that snapshot, so an overlap
// meant two billed calls whose final state depended on which write landed
// last rather than on user intent.
//
// Module-level because the guard has to be shared across both flows, and the
// plugin is a singleton in Obsidian. Cleared on unload.
const inFlight = new Set<string>();

// Returns false when the path is already being generated. Callers that get
// true must release() in a finally.
export function acquire(path: string): boolean {
  if (inFlight.has(path)) return false;
  inFlight.add(path);
  return true;
}

export function release(path: string): void {
  inFlight.delete(path);
}

export function isInFlight(path: string): boolean {
  return inFlight.has(path);
}

export function clearInFlight(): void {
  inFlight.clear();
}
