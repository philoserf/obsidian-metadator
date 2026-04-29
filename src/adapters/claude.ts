import Anthropic from "@anthropic-ai/sdk";
import type { MetadataToolSettings } from "../settings";

// Output budget for the model's tool-use response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;
const TOOL_NAME = "submit_metadata";

export type ClaudeErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
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
    return new ClaudeApiError("rate_limit", error.message);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ClaudeApiError("overloaded", error.message);
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeApiError("api", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ClaudeApiError("unknown", message);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
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
  });

  const tool = buildToolSchema(settings.enableTitle);

  let message: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    message = await anthropic.messages.create(
      {
        model: settings.anthropicModel,
        max_tokens: MAX_RESPONSE_TOKENS,
        system,
        messages: [{ role: "user", content: userMessage }],
        tools: [tool],
        tool_choice: { type: "tool", name: TOOL_NAME },
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

  if (!Array.isArray(message.content)) {
    throw new ClaudeApiError("api", "Response had no content blocks");
  }
  const toolUses = message.content.filter((block) => block.type === "tool_use");
  const toolUse = toolUses.find(
    (block) => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (!toolUse || toolUse.type !== "tool_use") {
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
