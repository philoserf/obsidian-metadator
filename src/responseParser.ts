import { z } from "zod";

export const MetadataResponseSchema = z
  .object({
    tags: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();

export type MetadataResponse = z.infer<typeof MetadataResponseSchema>;

export interface ParseResult {
  success: boolean;
  data?: MetadataResponse;
  error?: string;
  suggestion?: string;
}

export function parseClaudeResponse(text: string): ParseResult {
  // Extract JSON from response
  const jsonMatch = text.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return {
      success: false,
      error: "No JSON object found in Claude response",
      suggestion: "Claude may have returned malformed data. Check API logs.",
    };
  }

  // Attempt JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (error) {
    return {
      success: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
      suggestion:
        "Response contains text that looks like JSON but isn't valid.",
    };
  }

  // Validate schema
  const validation = MetadataResponseSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return {
      success: false,
      error: `Response validation failed: ${issues}`,
      suggestion: "Claude response structure doesn't match expected format.",
    };
  }

  return {
    success: true,
    data: validation.data,
  };
}
