import type { TruncateMethod } from "./content/truncate";

export const PROMPT_MAX_LENGTH = 1000;

// Ceiling for the numeric setting. Without one "positive integer" was the only
// rule, so an all-digit paste became a precision-lossy double that still
// satisfied n > 0 (#184). Context windows currently run 200k-1M tokens, so a
// content limit above that is meaningless rather than dangerous. Rounded generously so this does not
// have to track model specifications.
export const MAX_CONTENT_TOKEN_LIMIT = 1_000_000;

// Bump CURRENT_SCHEMA_VERSION whenever a new migration is added to MIGRATIONS
// in settingsMigrate.ts. Each migration's key is the schema version it produces.
export const CURRENT_SCHEMA_VERSION = 6;

export interface MetadataToolSettings {
  schemaVersion: number;

  // ID of the API key in Obsidian's secret storage (Settings → Keychain),
  // never the key: data.json is plaintext and Obsidian Sync copies it to every
  // device (#281). The key is resolved into a MetadataConfig at use.
  anthropicApiKeySecret: string;
  anthropicModel: string;

  // Field names in frontmatter
  descriptionFieldName: string;
  titleFieldName: string;

  // Feature toggles, one per field. A field that is off is not asked for, not
  // in the prompt, and never written (#305).
  enableDescription: boolean;
  enableTitle: boolean;
  debugLogging: boolean;

  // Content truncation
  truncateContent: boolean;
  contentTokenLimit: number;
  truncateMethod: TruncateMethod;

  // Write policy, one per field
  descriptionPolicy: WritePolicy;
  titlePolicy: WritePolicy;

  // Prompts
  descriptionPrompt: string;
  titlePrompt: string;
}

// Settings with the API key resolved out of secret storage. Built in one
// place, MetadataToolPlugin.config(), when a command runs, and never saved.
export type MetadataConfig = MetadataToolSettings & { anthropicApiKey: string };

// Shape of an Anthropic model id, deliberately loose. A well-formed but
// unknown id reaches the API and fails there with a clear error, which is a
// better outcome than silently resetting the user's choice to the default.
const MODEL_ID_PATTERN = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL_ID_MAX_LENGTH = 100;

// The two generated fields, in prompt order.
export type MetadataField = "description" | "title";
export const METADATA_FIELDS: readonly MetadataField[] = [
  "description",
  "title",
];

// Each field's settings keys, so code that walks the fields names them once.
export const FIELD_NAME_KEY = {
  description: "descriptionFieldName",
  title: "titleFieldName",
} as const satisfies Record<MetadataField, keyof MetadataToolSettings>;

export const FIELD_ENABLE_KEY = {
  description: "enableDescription",
  title: "enableTitle",
} as const satisfies Record<MetadataField, keyof MetadataToolSettings>;

type FieldToggles = Pick<
  MetadataToolSettings,
  "enableDescription" | "enableTitle"
>;

// The one answer to "which fields does a run generate?". The command, the CLI
// handler, the tool schema, the prompt and the write loop all
// read it, so no two of them can disagree about a field being on (#305).
export function enabledFields(settings: FieldToggles): Set<MetadataField> {
  return new Set(METADATA_FIELDS.filter((f) => settings[FIELD_ENABLE_KEY[f]]));
}

export function anyFieldEnabled(settings: FieldToggles): boolean {
  return enabledFields(settings).size > 0;
}

// What every entry point says when both are off. One string, so the
// Notice and the CLI error name the same settings.
export const NO_FIELDS_ENABLED_MESSAGE =
  "Nothing to generate: Enable description and Enable title are both off in Settings → Metadator.";

// The two frontmatter field names must differ. If they collide, the writes
// clobber each other in the user's note rather than in plugin state: the
// description is written and then the title overwrites the same key, the run
// reports success, and nothing surfaces the loss (#200).
//
// Shared so the load-time and edit-time rules cannot drift apart, the same
// reason isEmptyValue lives on its own.
export function areFieldNamesDistinct(
  names: Pick<MetadataToolSettings, "descriptionFieldName" | "titleFieldName"> &
    FieldToggles,
): boolean {
  // Only the names actually in use. A disabled field's name is inert —
  // shouldGenerate does not consult it, buildPrompt omits its instruction, and
  // the write loop never queues an update for it — so a stale value there
  // cannot clobber anything and must not be treated as if it could (#248).
  const inUse = [...enabledFields(names)].map((f) => names[FIELD_NAME_KEY[f]]);
  return new Set(inUse).size === inUse.length;
}

export function isModelId(value: string): boolean {
  return value.length <= MODEL_ID_MAX_LENGTH && MODEL_ID_PATTERN.test(value);
}

// Each of these records is both the option list and the display labels: the
// keys are the enumeration, the values are what the settings tab renders.
// Iterate with Object.entries and test membership with Object.hasOwn, so
// adding an option is a one-line edit in one place.

// Models offered in the settings dropdown. A convenience, not a constraint:
// anthropicModel accepts any well-formed model id (see isModelId), so a model
// released after this build can be typed in without a code change — hence the
// open `string` key rather than a closed union.
export const MODEL_OPTION_LABELS: Record<string, string> = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

// Keyed by TruncateMethod rather than deriving it: the type is defined in
// content/truncate.ts and imported here, deliberately, so content/ never
// imports settings. Annotating the record this way gets the same
// exhaustiveness check while keeping that dependency pointing the right way.
export const TRUNCATE_METHOD_LABELS: Record<TruncateMethod, string> = {
  head_only: "Beginning Only",
  head_tail: "Beginning + End",
  heading: "Headings + Summaries",
};

// One policy per field, because the two fields are kept differently (#252):
// `description` is cheap and disposable, so it is fine to replace; `title` is
// often externally synced and load-bearing, so it defaults to being left
// alone. One vocabulary for both, so "always regenerate" is a single idea you
// turn on per field. This record is the enumeration — see the note above
// MODEL_OPTION_LABELS.
export const WRITE_POLICY_LABELS = {
  regenerate: "Always Regenerate",
  preserve: "Preserve Existing",
};

export type WritePolicy = keyof typeof WRITE_POLICY_LABELS;

export const DEFAULT_SETTINGS: MetadataToolSettings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,

  anthropicApiKeySecret: "",
  anthropicModel: "claude-sonnet-5",

  descriptionFieldName: "description",
  titleFieldName: "title",

  enableDescription: true,
  enableTitle: true,
  debugLogging: false,

  truncateContent: true,
  contentTokenLimit: 1000,
  truncateMethod: "head_only",

  // Defaults differ per field on purpose. description regenerates because it
  // is cheap and disposable; title preserves because it is frequently kept in
  // sync by another plugin or relied on by a publisher, and rewriting it
  // silently changes a note's public identity.
  descriptionPolicy: "regenerate",
  titlePolicy: "preserve",

  // These are starting points a user is expected to edit, so they are written
  // as rules a model can actually check itself against rather than adjectives
  // ("concise but useful") that it cannot. The title prompt also closes a
  // failure this codebase has had to handle downstream: titles came back
  // wrapped in quotation marks often enough that stripSurroundingQuotes exists
  // to unwrap them. Saying so here is a fix at the source; that function stays
  // as a backstop.
  descriptionPrompt:
    'Write 1-2 sentences, at most 40 words, saying what the note covers and its most useful specifics. Begin with the subject itself — no "This note...", "This article..." or similar preamble. Do not restate the title. Use plain present-tense prose.',
  titlePrompt:
    "Write a title in sentence case: capitalize only the first word and proper nouns. Keep it under 10 words, state the topic directly, and leave out adjectives that add no information. Return the title text only — no surrounding quotation marks and no trailing punctuation.",
};
