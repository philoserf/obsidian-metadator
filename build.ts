import { watch } from "fs";
import { resolve } from "path";

const isWatch = process.argv.includes("--watch");

async function build() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    external: ["obsidian", "electron"],
    minify: !isWatch,
  });

  if (!result.success) {
    console.error("Build failed");
    for (const message of result.logs) console.error(message);
    if (!isWatch) process.exit(1);
    return;
  }

  console.log("Build succeeded");
}

await build();

if (isWatch) {
  console.log("Watching src/ for changes...");
  let debounce: ReturnType<typeof setTimeout> | null = null;
  watch(resolve("src"), { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`Rebuilding (${filename} changed)...`);
      await build();
    }, 100);
  });
}

export {};
