import Anthropic from "@anthropic-ai/sdk";
import type { MetadataToolSettings } from "../settings";

// Output budget for the model's JSON response (tags + description + title).
// Distinct from settings.contentTokenLimit, which bounds the input note content.
const MAX_RESPONSE_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;

export interface CallClaudeOptions {
  signal?: AbortSignal;
}

export async function callClaude(
  system: string,
  userMessage: string,
  settings: MetadataToolSettings,
  options: CallClaudeOptions = {},
): Promise<string> {
  // Allowing browser compatibility mode — safe within Obsidian's Electron-controlled environment under current use cases.
  // Note: Ensure that all inputs/outputs to/from the Anthropic client are properly sanitized and validated, as `dangerouslyAllowBrowser` may reduce some security safeguards.
  const anthropic = new Anthropic({
    apiKey: settings.anthropicApiKey,
    dangerouslyAllowBrowser: true,
  });

  const message = await anthropic.messages.create(
    {
      model: settings.anthropicModel,
      max_tokens: MAX_RESPONSE_TOKENS,
      system,
      messages: [{ role: "user", content: userMessage }],
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      signal: options.signal,
    },
  );

  if (message.content.length > 0 && message.content[0].type === "text") {
    return message.content[0].text;
  }

  throw new Error("No text content in response");
}
