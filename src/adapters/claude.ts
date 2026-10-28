import Anthropic from "@anthropic-ai/sdk";
import { isAbortError } from "../errors";
import {
  choiceValues,
  enabledFields,
  METADATA_FIELDS,
  type MetadataConfig,
  type MetadataField,
  type MetadataToolSettings,
} from "../settings";

// Output budget for the model's tool-use response (every generated field).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
// Models on the auto-tool-choice path think before answering, and thinking
// tokens count against max_tokens. 2048 leaves too little room for the tool
// call to land, so give that path its own larger budget.
const MAX_RESPONSE_TOKENS_AUTO_TOOL_CHOICE = 8192;
const REQUEST_TIMEOUT_MS = 60_000;
// The SDK's own retries are the only ones: a rate limit, overload or dropped
// connection is retried up to twice, then surfaces to the user. Pinned rather
// than left to the SDK default so a change to it is deliberate.
export const SDK_MAX_RETRIES = 2;
const TOOL_NAME = "submit_metadata";

// Models that reject a forced tool_choice ({type: "tool"}) with a 400: the
// fable and mythos families by prefix, so later releases are handled without a
// code change, and Claude Opus 5.5 by id (Claude Opus 5 still accepts forcing).
// These models get tool_choice "auto" plus an explicit instruction.
const AUTO_TOOL_CHOICE_FAMILIES = /^claude-(?:fable-|mythos-|opus-5-5)/;

// Appended to the system prompt on the auto path, where nothing but the
// instruction makes the model call the tool.
const TOOL_CALL_INSTRUCTION = `Respond only by calling the ${TOOL_NAME} tool. Do not write a text reply.`;

export function usesAutoToolChoice(model: string): boolean {
  return AUTO_TOOL_CHOICE_FAMILIES.test(model);
}

export type ClaudeErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "connection"
  | "api"
  | "unknown";

export class ClaudeApiError extends Error {
  readonly kind: ClaudeErrorKind;
  constructor(kind: ClaudeErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ClaudeApiError";
  }
}

// A free-text field is present exactly when it was enabled for the request: a
// disabled field is neither declared in the tool schema nor read from the
// response. A choice field may also be absent when enabled — the model chose
// none, or answered off the list — and absent means "write nothing" (#308).
export type MetadataFields = Partial<Record<MetadataField, string>>;

// `| undefined`: callers forward an optional signal, and absent and undefined
// both mean "not cancellable".
export interface CallClaudeOptions {
  signal?: AbortSignal | undefined;
}

interface JsonSchemaProperty {
  type: "string";
  description: string;
  enum?: string[];
}

const SCHEMA_DESCRIPTION: Record<MetadataField, string> = {
  description:
    "Brief summary of the article. Follow the user's description instructions.",
  title: "Concise title for the article. Follow the user's title instructions.",
  eyebrow:
    "The article's form. Follow the user's eyebrow instructions; an empty string means none applies.",
};

// The answer a choice field gives when none of its values applies. In the
// enum beside the values, so "none" is a choice the model makes rather than a
// field it leaves out, and it cannot collide with a configured value.
export const NO_CHOICE = "";

// Only the enabled fields are declared, and every declared field is required.
// A disabled field is absent from both lists, so the model is never asked for
// it (#305). A choice field is an enum of its values plus NO_CHOICE (#308).
// Exported for tests.
export function buildToolSchema(
  fields: ReadonlySet<MetadataField>,
  settings: Pick<MetadataToolSettings, "eyebrowValues">,
) {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: MetadataField[] = [];
  for (const field of METADATA_FIELDS) {
    if (!fields.has(field)) continue;
    const values = choiceValues(settings, field);
    properties[field] = {
      type: "string",
      description: SCHEMA_DESCRIPTION[field],
      ...(values && { enum: [...values, NO_CHOICE] }),
    };
    required.push(field);
  }
  return {
    name: TOOL_NAME,
    description:
      "Submit the generated metadata for the article. This is the only way to return results: call it once, with every required field. Each value is written into the note's YAML frontmatter as given.",
    input_schema: {
      type: "object" as const,
      properties,
      required,
    },
  };
}

function classifyError(error: unknown): ClaudeApiError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ClaudeApiError("auth", error.message);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeApiError("rate_limit", error.message);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ClaudeApiError("overloaded", error.message);
  }
  // Above the APIError branch on purpose: APIConnectionTimeoutError extends
  // APIConnectionError extends APIError, so the generic branch would swallow
  // both and this kind would be unreachable. One check covers the timeout too.
  if (error instanceof Anthropic.APIConnectionError) {
    return new ClaudeApiError("connection", error.message);
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeApiError("api", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ClaudeApiError("unknown", message);
}

// Exported for tests.
export function validateMetadataInput(
  input: unknown,
  fields: ReadonlySet<MetadataField>,
  settings: Pick<MetadataToolSettings, "eyebrowValues">,
): MetadataFields {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClaudeApiError("api", "Tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  const out: MetadataFields = {};
  for (const field of METADATA_FIELDS) {
    if (!fields.has(field)) continue;
    const value = obj[field];
    const values = choiceValues(settings, field);
    if (values) {
      // A choice field never fails the request: none, a missing value and an
      // off-list value all mean "write nothing", so the free-text fields that
      // arrived correctly are kept (#308).
      if (typeof value === "string" && values.includes(value)) {
        out[field] = value;
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new ClaudeApiError(
        "api",
        `Tool input field '${field}' is missing or not a string`,
      );
    }
    out[field] = value;
  }
  // No `else` branches: a disabled field is not declared by buildToolSchema,
  // so a volunteered one is already off-schema, and metadata.ts guards its
  // write on the same enabledFields that built this set — the value could
  // never be read. Validating it anyway meant a malformed value failed the
  // whole generation, discarding the fields that arrived correctly, over a
  // field the user switched off. An off-schema field is ignored, like every
  // other unexpected key.
  return out;
}

// One client per API key. Constructing it per call meant one per note, each
// starting with an empty connection pool, so a run of CLI calls paid TLS setup
// repeatedly and forfeited keep-alive reuse (#207). Keyed on the key so a settings change is
// never served by a stale client.
let cachedClient: { apiKey: string; client: Anthropic } | undefined;

function getClient(apiKey: string): Anthropic {
  if (cachedClient !== undefined && cachedClient.apiKey === apiKey) {
    return cachedClient.client;
  }
  cachedClient = {
    apiKey,
    // Allowing browser compatibility mode — safe within Obsidian's Electron-controlled environment under current use cases.
    client: new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
      maxRetries: SDK_MAX_RETRIES,
    }),
  };
  return cachedClient.client;
}

// For tests. mock.module is per-file but this module loads once, so a client
// built under one file's mocked SDK would otherwise be served to another file
// using the same key.
export function resetClientCache(): void {
  cachedClient = undefined;
}

export async function callClaudeForMetadata(
  system: string,
  userMessage: string,
  settings: MetadataConfig,
  options: CallClaudeOptions = {},
): Promise<MetadataFields> {
  const anthropic = getClient(settings.anthropicApiKey);

  const fields = enabledFields(settings);
  const tool = buildToolSchema(fields, settings);
  const autoToolChoice = usesAutoToolChoice(settings.anthropicModel);

  let message: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    message = await anthropic.messages.create(
      {
        model: settings.anthropicModel,
        max_tokens: autoToolChoice
          ? MAX_RESPONSE_TOKENS_AUTO_TOOL_CHOICE
          : MAX_RESPONSE_TOKENS,
        system: autoToolChoice
          ? `${system}\n\n${TOOL_CALL_INSTRUCTION}`
          : system,
        messages: [{ role: "user", content: userMessage }],
        tools: [tool],
        // Forced tool use is a 400 on the auto families; keep it everywhere
        // else, where it is the stronger guarantee.
        tool_choice: autoToolChoice
          ? { type: "auto" }
          : { type: "tool", name: TOOL_NAME },
        // Metadata extraction needs no deep reasoning; low effort keeps the
        // thinking these models always do from crowding out the tool call.
        ...(autoToolChoice
          ? { output_config: { effort: "low" as const } }
          : {}),
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        signal: options.signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw classifyError(error);
  }

  // Checked before the content blocks, because a truncated tool call can still
  // parse. validateMetadataInput only asserts the fields are strings, not that
  // they are complete, so a description cut off mid-sentence would be written
  // to frontmatter with nothing to signal it (#174). Not retryable: the same
  // prompt overflows the same way, so it is a configuration problem rather
  // than a blip.
  if (message.stop_reason === "max_tokens") {
    throw new ClaudeApiError(
      "api",
      "Response was truncated at the token limit; the generated metadata would have been incomplete",
    );
  }

  if (!Array.isArray(message.content)) {
    throw new ClaudeApiError("api", "Response had no content blocks");
  }
  const toolUses = message.content.filter((block) => block.type === "tool_use");
  const toolUse = toolUses.find(
    (block) => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (toolUse?.type !== "tool_use") {
    if (toolUses.length > 0) {
      const names = toolUses
        .map((block) => (block.type === "tool_use" ? block.name : ""))
        .filter((n) => n !== "")
        .join(", ");
      throw new ClaudeApiError(
        "api",
        `Model called unexpected tool(s): ${names}`,
      );
    }
    throw new ClaudeApiError("api", "Model did not call the metadata tool");
  }
  return validateMetadataInput(toolUse.input, fields, settings);
}
