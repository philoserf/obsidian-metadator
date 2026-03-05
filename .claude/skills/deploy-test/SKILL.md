# Deploy Test

Build and deploy the plugin to the test vault.

## Steps

1. Run `bun run build` (includes typecheck + lint)
2. Run `bun test`
3. Run `bun run deploy` to copy to notes vault
4. Remind user to reload Obsidian (Cmd+R)

## Rules

- Abort if build or tests fail
- Report any new lint warnings
