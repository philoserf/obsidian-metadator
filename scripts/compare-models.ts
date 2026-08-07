// Dev tool: sends the same note content to the live Anthropic API once per
// configurable model and prints the resulting tags/description/title side
// by side. Not part of `bun test` — it costs money, hits the network, and
// has nothing deterministic to assert. Run with:
//
//   ANTHROPIC_API_KEY=sk-... bun run compare-models [path/to/note.md]

import { readFileSync } from "node:fs";
import { ClaudeApiError, callClaudeForMetadata } from "../src/adapters/claude";
import { buildPrompt } from "../src/prompt";
import { DEFAULT_SETTINGS, VALID_MODEL_OPTIONS } from "../src/settings";

const SAMPLE_CONTENT = `# Composting for apartment dwellers

Most guides assume a backyard, but you can compost effectively in 500
square feet. A small worm bin (vermicomposting) handles food scraps
without odor if you keep the bedding moist and avoid citrus and meat.

Red wigglers (Eisenia fetida) are the standard worm for this — they
tolerate handling and reproduce quickly in a contained bin. A
plastic tote with drilled air holes works as well as a purchased
bin. Harvest the finished castings every two to three months and use
them to top-dress houseplants or a balcony container garden.

The main failure mode is overfeeding: rotting scraps outpace what the
worms can process and the bin turns anaerobic and smells. Start with
small amounts and increase gradually as the worm population grows.`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — see scripts/compare-models.ts");
    process.exit(1);
  }

  const contentPath = process.argv[2];
  const content = contentPath
    ? readFileSync(contentPath, "utf-8")
    : SAMPLE_CONTENT;

  console.log(
    `Comparing ${VALID_MODEL_OPTIONS.length} models on ${contentPath ?? "the built-in sample note"}\n`,
  );

  for (const model of VALID_MODEL_OPTIONS) {
    const settings = {
      ...DEFAULT_SETTINGS,
      anthropicApiKey: apiKey,
      anthropicModel: model,
    };
    const { system, userMessage } = buildPrompt(content, settings);

    console.log(`## ${model}`);
    const startedAt = Date.now();
    try {
      const metadata = await callClaudeForMetadata(
        system,
        userMessage,
        settings,
      );
      const durationMs = Date.now() - startedAt;
      console.log(`  tags:        ${metadata.tags}`);
      console.log(`  description: ${metadata.description}`);
      if (metadata.title) console.log(`  title:       ${metadata.title}`);
      console.log(`  (${durationMs}ms)\n`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message =
        error instanceof ClaudeApiError
          ? `[${error.kind}] ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.log(`  ERROR: ${message} (${durationMs}ms)\n`);
    }
  }
}

await main();
