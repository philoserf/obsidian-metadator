// The last step of `bun run build`: copy the plugin into a vault. Bun loads
// OBSIDIAN_DEPLOY_DEST from the gitignored .env.local (see .env.local.example);
// unset, as on a machine without the vault, the build stops at ./main.js.
import { existsSync } from "node:fs";
import { $ } from "bun";

const dest = process.env.OBSIDIAN_DEPLOY_DEST;
if (!dest) {
  console.log("OBSIDIAN_DEPLOY_DEST not set — built ./main.js only");
  process.exit(0);
}

const files = ["main.js", "manifest.json", "styles.css"].filter((f) =>
  existsSync(f),
);
await $`mkdir -p ${dest}`;
await $`cp ${files} ${dest}`;
console.log(`Installed ${files.join(", ")} to ${dest}`);
