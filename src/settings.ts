import type { TruncateMethod } from "./content/truncate";

export const PROMPT_MAX_LENGTH = 1000;

// Ceilings for the two numeric settings. Without them "positive integer" was
// the only rule, so an all-digit paste became a precision-lossy double that
// still satisfied n > 0 — and maxBulkFiles, whose whole job is to be a hard
// limit, could be set to a value that defeats it (#184).
export const MAX_BULK_FILES = 100_000;
// Context windows currently run 200k-1M tokens, so a content limit above that
// is meaningless rather than dangerous. Rounded generously so this does not
// have to track model specifications.
export const MAX_CONTENT_TOKEN_LIMIT = 1_000_000;

// Bump CURRENT_SCHEMA_VERSION whenever a new migration is added to MIGRATIONS
// in main.ts. Each migration's key is the schema version it produces.
export const CURRENT_SCHEMA_VERSION = 2;

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

// Models offered in the settings dropdown. This list is a convenience, not a
// constraint: anthropicModel accepts any well-formed model id (see
// isModelId), so a model released after this build can be typed in without a
// code change.
export const VALID_MODEL_OPTIONS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
] as const;

// Shape of an Anthropic model id, deliberately loose. A well-formed but
// unknown id reaches the API and fails there with a clear error, which is a
// better outcome than silently resetting the user's choice to the default.
const MODEL_ID_PATTERN = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL_ID_MAX_LENGTH = 100;

export function isModelId(value: string): boolean {
  return value.length <= MODEL_ID_MAX_LENGTH && MODEL_ID_PATTERN.test(value);
}

export const MODEL_OPTION_LABELS: Record<
  (typeof VALID_MODEL_OPTIONS)[number],
  string
> = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

export const VALID_TRUNCATE_METHOD_OPTIONS = [
  "head_only",
  "head_tail",
  "heading",
] as const;

export const TRUNCATE_METHOD_LABELS: Record<
  (typeof VALID_TRUNCATE_METHOD_OPTIONS)[number],
  string
> = {
  head_only: "Beginning Only",
  head_tail: "Beginning + End",
  heading: "Headings + Summaries",
};

export const VALID_UPDATE_METHOD_OPTIONS = [
  "always_regenerate",
  "preserve_existing",
] as const;

export const UPDATE_METHOD_LABELS: Record<
  (typeof VALID_UPDATE_METHOD_OPTIONS)[number],
  string
> = {
  always_regenerate: "Always Regenerate",
  preserve_existing: "Preserve Existing",
};

export const DEFAULT_SETTINGS: MetadataToolSettings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,

  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-5",

  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",

  enableTitle: true,
  debugLogging: false,

  truncateContent: true,
  contentTokenLimit: 1000,
  truncateMethod: "head_only",

  updateMethod: "preserve_existing",

  maxBulkFiles: 500,

  tagsPrompt:
    "Select 3-5 relevant tags in lowercase with hyphens instead of spaces (e.g., 'knowledge-management', 'note-taking')",
  descriptionPrompt:
    "Write a concise but useful summary in 1-2 sentences that captures the main purpose and key points",
  titlePrompt:
    "Create a simple, concise title with minimal adjectives that clearly states the topic",
};
