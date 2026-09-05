import Anthropic from "@anthropic-ai/sdk";
import { isAbortError } from "../errors";
import type { MetadataToolSettings } from "../settings";

// Output budget for the model's tool-use response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
// Models on the auto-tool-choice path think before answering, and thinking
// tokens count against max_tokens. 2048 leaves too little room for the tool
// call to land, so give that path its own larger budget.
const MAX_RESPONSE_TOKENS_AUTO_TOOL_CHOICE = 8192;
const REQUEST_TIMEOUT_MS = 60_000;
// The SDK retries internally beneath the bulk retry policy, so one logical
// attempt can be several HTTP requests. Pinned rather than left to the SDK
// default so the confirm modal's worst-case call estimate stays truthful.
export const SDK_MAX_RETRIES = 2;
export const REQUESTS_PER_ATTEMPT = SDK_MAX_RETRIES + 1;
const TOOL_NAME = "submit_metadata";

// Model families that reject a forced tool_choice ({type: "tool"}) with a 400.
// Claude Fable 5.1 dropped forced tool use; match the whole family by prefix
// so later releases (fable 5.2, mythos, ...) are handled without a code
// change. These models get tool_choice "auto" plus an explicit instruction.
const AUTO_TOOL_CHOICE_FAMILIES = /^claude-(?:fable|mythos)-/;

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
  readonly retryAfterMs?: number;
  constructor(kind: ClaudeErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.name = "ClaudeApiError";
  }
}

export function parseRetryAfterMs(
  headers: { get?: (name: string) => string | null } | undefined,
): number | undefined {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // Retry-After may also be an HTTP-date; fall back to the computed delay
  // rather than parsing dates here.
  return undefined;
}

export interface MetadataFields {
  tags: string;
  description: string;
  title?: string;
}

export interface CallClaudeOptions {
  signal?: AbortSignal;
}

function buildToolSchema(includeTitle: boolean) {
  const properties: Record<string, { type: "string"; description: string }> = {
    tags: {
      type: "string",
      description:
        "Comma-separated tags describing the article. Follow the user's tag instructions.",
    },
    description: {
      type: "string",
      description:
        "Brief summary of the article. Follow the user's description instructions.",
    },
  };
  const required = ["tags", "description"];
  if (includeTitle) {
    properties.title = {
      type: "string",
      description:
        "Concise title for the article. Follow the user's title instructions.",
    };
    required.push("title");
  }
  return {
    name: TOOL_NAME,
    description: "Submit the generated metadata for the article.",
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
    return new ClaudeApiError(
      "rate_limit",
      error.message,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ClaudeApiError(
      "overloaded",
      error.message,
      parseRetryAfterMs(error.headers),
    );
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

function validateMetadataInput(
  input: unknown,
  includeTitle: boolean,
): MetadataFields {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClaudeApiError("api", "Tool input was not an object");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.tags !== "string") {
    throw new ClaudeApiError(
      "api",
      "Tool input field 'tags' is missing or not a string",
    );
  }
  if (typeof obj.description !== "string") {
    throw new ClaudeApiError(
      "api",
      "Tool input field 'description' is missing or not a string",
    );
  }
  const out: MetadataFields = {
    tags: obj.tags,
    description: obj.description,
  };
  if (includeTitle) {
    if (typeof obj.title !== "string") {
      throw new ClaudeApiError(
        "api",
        "Tool input field 'title' is missing or not a string",
      );
    }
    out.title = obj.title;
  } else if (obj.title !== undefined) {
    if (typeof obj.title !== "string") {
      throw new ClaudeApiError(
        "api",
        "Tool input field 'title' is not a string",
      );
    }
    out.title = obj.title;
  }
  return out;
}

export async function callClaudeForMetadata(
  system: string,
  userMessage: string,
  settings: MetadataToolSettings,
  options: CallClaudeOptions = {},
): Promise<MetadataFields> {
  // Allowing browser compatibility mode — safe within Obsidian's Electron-controlled environment under current use cases.
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: SDK_MAX_RETRIES,
  });

  const tool = buildToolSchema(settings.enableTitle);
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
  // prompt overflows the same way, and after five in a row the bulk halt tells
  // the user this is a configuration problem rather than a blip.
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
  return validateMetadataInput(toolUse.input, settings.enableTitle);
}
