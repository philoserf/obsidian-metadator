import { $ } from "bun";

const dest = process.env.OBSIDIAN_METADATOR_DEST;
if (!dest) {
  console.error("OBSIDIAN_METADATOR_DEST not set — see .env.local");
  process.exit(1);
}

await $`cp main.js manifest.json ${dest}`;
console.log(`Deployed to ${dest}`);
