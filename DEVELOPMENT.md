# Development Guide

This project is set up as both a development environment and a test Obsidian vault.

## Quick Start

1. Install dependencies:

   ```bash
   bun install
   ```

2. Build the plugin:

   ```bash
   bun run build
   ```

   Or run in watch mode for development:

   ```bash
   bun run dev
   ```

3. Open this folder as a vault in Obsidian:
   - Open Obsidian
   - Click "Open folder as vault"
   - Select this project directory
   - The plugin will be automatically loaded

## Plugin Structure

The plugin files are symlinked from `.obsidian/plugins/obsidian-metadata-tool/` to the build output:

- `main.js` → `main.js` (in project root)
- `manifest.json` → `manifest.json`

This means any changes you make will be reflected immediately after rebuilding.

## Development Workflow

1. Make changes to the source files in `src/`
2. The build will automatically run if you're using `bun run dev`
3. In Obsidian, reload the plugin:
   - Open Command Palette (Cmd/Ctrl + P)
   - Run "Reload app without saving"
   - Or disable and re-enable the plugin in Settings

## Testing

Three sample notes are provided for testing:

- [Sample Note 1.md](Sample Note 1.md) - About Obsidian
- [Sample Note 2.md](Sample Note 2.md) - Morning routine
- [Sample Note 3.md](Sample Note 3.md) - Machine learning

To test the plugin:

1. Open one of the sample notes
2. Run the command "Generate metadata for current note" (Cmd/Ctrl + P)
3. Check the frontmatter that gets added

## Configuration

Before using the plugin, you need to:

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com)
2. Open Settings → Metadator
3. Add your API key
4. Configure other settings as needed

## Project Scripts

- `bun run dev` - Watch mode with auto-rebuild
- `bun run build` - Production build (includes type checking and linting)
- `bun run check` - Run Biome checks and markdownlint
- `bun run typecheck` - TypeScript type checking only
- `bun run lint` - Run Biome linting
- `bun run lint:fix` - Auto-fix linting issues
- `bun run format` - Format code with Biome
- `bun run format:check` - Check formatting without changes
- `bun run validate` - Full validation before release

## Debugging

To debug the plugin:

1. Open Developer Tools in Obsidian (Cmd/Ctrl + Shift + I)
2. Check the Console tab for errors
3. Add `console.log()` statements in your code
4. Rebuild and reload the plugin

## File Structure

```text
.
├── src/
│   ├── main.ts          # Plugin entry point
│   ├── settings.ts      # Settings interface
│   ├── settingsTab.ts   # Settings UI
│   ├── metadata.ts      # Metadata generation logic
│   └── utils.ts         # Utility functions (API calls, etc.)
├── scripts/
│   └── validate-plugin.ts  # Pre-release validation
├── .obsidian/
│   └── plugins/
│       └── obsidian-metadata-tool/  # Symlinked plugin files
├── main.js              # Build output (committed to repo)
├── manifest.json        # Plugin manifest
├── package.json         # NPM dependencies
└── tsconfig.json        # TypeScript configuration
```

## Making Changes

1. Edit files in `src/`
2. The watcher will rebuild automatically (if using `bun run dev`)
3. Reload Obsidian to see changes
4. Check console for any errors

## Common Issues

### Plugin not loading

- Make sure you've run `bun run build` at least once
- Check that the symlinks exist in `.obsidian/plugins/obsidian-metadata-tool/`
- Verify the plugin is enabled in Settings → Community Plugins

### Changes not appearing

- Make sure you've reloaded Obsidian after rebuilding
- Check the console for any JavaScript errors
- Verify the build completed successfully

### API errors

- Verify your Anthropic API key is correct
- Check your internet connection
- Look at the console for specific error messages
