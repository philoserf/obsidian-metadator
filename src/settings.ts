export interface MetadataToolSettings {
  anthropicApiKey: string;
  anthropicModel: string;

  // Field names in frontmatter
  tagsFieldName: string;
  descriptionFieldName: string;
  titleFieldName: string;

  // Feature toggles
  enableTitle: boolean;

  // Content truncation
  truncateContent: boolean;
  maxTokens: number;
  truncateMethod: "head_only" | "head_tail" | "heading";

  // Update behavior
  updateMethod: "always_regenerate" | "preserve_existing";

  // Prompts
  tagsPrompt: string;
  descriptionPrompt: string;
  titlePrompt: string;
}

export const DEFAULT_SETTINGS: MetadataToolSettings = {
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-5-20250929",

  tagsFieldName: "tags",
  descriptionFieldName: "description",
  titleFieldName: "title",

  enableTitle: true,

  truncateContent: true,
  maxTokens: 1000,
  truncateMethod: "head_only",

  updateMethod: "preserve_existing",

  tagsPrompt:
    "Select 3-5 relevant tags in lowercase with hyphens instead of spaces (e.g., 'knowledge-management', 'note-taking')",
  descriptionPrompt:
    "Write a concise but useful summary in 1-2 sentences that captures the main purpose and key points",
  titlePrompt:
    "Create a simple, concise title with minimal adjectives that clearly states the topic",
};
