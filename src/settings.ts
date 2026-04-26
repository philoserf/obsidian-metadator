export interface MetadataToolSettings {
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
  truncateMethod: "head_only" | "head_tail" | "heading";

  // Update behavior
  updateMethod: "always_regenerate" | "preserve_existing";

  // Prompts
  tagsPrompt: string;
  descriptionPrompt: string;
  titlePrompt: string;
}

export const VALID_MODEL_OPTIONS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export const MODEL_OPTION_LABELS: Record<
  (typeof VALID_MODEL_OPTIONS)[number],
  string
> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
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
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6",

  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",

  enableTitle: true,
  debugLogging: false,

  truncateContent: true,
  contentTokenLimit: 1000,
  truncateMethod: "head_only",

  updateMethod: "preserve_existing",

  tagsPrompt:
    "Select 3-5 relevant tags in lowercase with hyphens instead of spaces (e.g., 'knowledge-management', 'note-taking')",
  descriptionPrompt:
    "Write a concise but useful summary in 1-2 sentences that captures the main purpose and key points",
  titlePrompt:
    "Create a simple, concise title with minimal adjectives that clearly states the topic",
};
