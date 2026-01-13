# Metadator

Automatically generate metadata for your Obsidian notes using Claude AI from Anthropic.
The plugin analyzes your note content and generates tags, descriptions, and titles—with full
customization for your workflow.

## Features

- **AI-Powered Metadata**: Generate tags, descriptions, and titles using Claude AI
- **Flexible Updates**: Force update all fields or only fill in missing metadata
- **Cost Optimization**: Truncate content to limit API usage (save money on large notes)
- **Customizable Fields**: Rename metadata fields and add custom key-value pairs
- **Multiple Models**: Choose from Claude Sonnet 4.5, Opus 4.5, Sonnet 3.7, or Haiku 3.5
- **Tag Extraction**: Extract and manage existing tags from your vault
- **Custom Prompts**: Write your own instructions for tag/description/title generation

## Installation

### From Source (Development)

1. Clone this repository into your vault's plugins folder:

   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/markayers/metadator.git
   cd metadator
   ```

2. Install dependencies with Bun:

   ```bash
   bun install
   ```

3. Build the plugin:

   ```bash
   bun run build
   ```

4. Enable the plugin in Obsidian: Settings → Community Plugins → Metadator

## Configuration

### Anthropic API Key

1. Get an API key:
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Sign up or log in
   - Add billing information (Claude API requires a paid account)
   - Create a new API key

2. Add to Metadator:
   - In Obsidian, open Settings (gear icon, bottom left)
   - Find "Metadator" in Community Plugins
   - Paste your API key in the "API Key" field

### Metadata Settings

#### API Settings

- **Model**: Choose your Claude model
  - **Sonnet 4.5** (recommended): Best balance of speed and quality
  - **Opus 4.5**: Most capable, slower and more expensive
  - **Sonnet 3.7**: Good balance of speed and cost
  - **Haiku 3.5**: Fastest and cheapest, good for simple notes

#### Update Method

- **Force Update**: Regenerate all metadata fields every time
- **Update Empty Only** (default): Only fill in missing fields, preserve existing metadata

#### Content Truncation

Enable to reduce API costs on large notes:

- **Truncate Content**: Enable/disable content limiting
- **Max Tokens**: Maximum content length to send to Claude (default: 1000)
- **Truncation Method**:
  - **Beginning Only**: Send just the first N tokens
  - **Beginning + End**: Send start and end, omit middle
  - **Headings**: Send document outline plus first paragraph of each section

#### Field Names

Customize what the frontmatter fields are called:

- **Tags Field**: Default `tags`
- **Description Field**: Default `description`
- **Title Field**: Default `title`

#### Prompts

Write custom instructions for Claude:

- **Tags Prompt**: How to select tags (e.g., "Choose 3-5 relevant tags")
- **Description Prompt**: How to write descriptions (e.g., "One sentence summary")
- **Title Prompt**: How to generate titles (e.g., "Concise title, max 10 words")

#### Custom Metadata

Add any additional metadata fields (e.g., `author: Your Name`, `status: draft`)

## Usage

### Generating Metadata for One Note

1. Open a note you want to add metadata to
2. Open Command Palette: Cmd/Ctrl + P
3. Search for "Metadator" and select "Generate metadata for current note"
4. Watch the plugin analyze your content and update the frontmatter

### Example

**Before:**

```markdown
---
---

# My Morning Routine

I wake up at 6am and start with a 20-minute meditation session. Then I exercise for 30
minutes, take a cold shower, and have a healthy breakfast. This routine has improved my
energy levels and focus throughout the day.
```

**After:**

```markdown
---
tags:
  - habits
  - wellness
  - productivity
description: A morning routine focused on meditation, exercise, and nutrition to boost energy and focus
title: Morning Routine for Productivity
---

# My Morning Routine

[content unchanged...]
```

## Development

### Prerequisites

- [Bun](https://bun.sh) - Fast JavaScript runtime and package manager
- Node.js 18+ (via Bun)

### Setup

```bash
# Install dependencies
bun install

# Development mode (watch mode with inline source maps)
bun run dev

# Production build (minified, optimized)
bun run build

# Type checking
bun run typecheck

# Linting and formatting
bun run check
bun run format

# Full validation (types, lint, format, build)
bun run validate
```

### Build Optimization

The project uses Bun's bundler with optimizations:

- **Production** (`bun run build`): Minified output (~81 KB)
- **Development** (`bun run dev`): Watch mode with source maps for debugging

All builds:

- Bundle dependencies (@anthropic-ai/sdk) into a single file
- Externalize Obsidian API and Electron (provided by Obsidian)
- Target Node.js runtime with CommonJS format
- Output to `main.js` (Obsidian plugin entry point)

### Project Structure

```text
metadator/
├── src/
│   ├── main.ts          # Plugin entry point and commands
│   ├── settings.ts      # Settings interface and management
│   ├── settingsTab.ts   # Settings UI
│   ├── metadata.ts      # Claude integration and metadata generation
│   └── utils.ts         # Utility functions (API calls, token counting, etc.)
├── scripts/
│   └── validate-plugin.ts  # Pre-release validation
├── manifest.json        # Obsidian plugin metadata
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── biome.json           # Linter/formatter configuration
```

### Architecture

1. **Main Plugin** (`main.ts`) - Registers commands and manages plugin lifecycle
2. **Settings** (`settings.ts`) - Configuration interface and data management
3. **Settings Tab** (`settingsTab.ts`) - Obsidian UI for settings
4. **Metadata Generator** (`metadata.ts`) - Claude API integration and metadata generation
5. **Utilities** (`utils.ts`) - Token counting, content truncation, API helpers

## Troubleshooting

### Plugin Not Loading

- Check the developer console (Cmd/Ctrl + Shift + I) for errors
- Ensure `main.js` exists in the plugin directory
- Verify Obsidian version is 1.0.0 or higher
- Reload Obsidian (Cmd/Ctrl + R)

### "Please configure your Anthropic API key"

- You haven't added an API key yet
- Go to Settings → Metadator and add your key
- Verify you have billing enabled on your Anthropic account

### "Authentication failed"

- Your API key is incorrect or invalid
- Copy a fresh key from [console.anthropic.com](https://console.anthropic.com)
- Ensure there are no extra spaces when pasting

### "Rate limit exceeded"

- You're making requests too quickly
- Wait a moment and try again
- Consider using Haiku 3.5 for faster requests

### No Metadata Generated

- Check the Developer Console (Cmd/Ctrl + Shift + I) for error details
- Ensure the note has enough content
- Try enabling "Force Update" in settings
- Verify your API key is valid

### Changes Not Appearing

- Ensure you saved the settings
- Try disabling and re-enabling the plugin
- Reload Obsidian (Cmd/Ctrl + R)

## Bun Runtime Features

The project leverages Bun's runtime capabilities:

1. **Native TypeScript execution** - Run .ts files directly without compilation
2. **Fast bundling** - Sub-10ms builds with Bun's bundler
3. **Shell scripting** - `scripts/validate-plugin.ts` uses Bun's `$` for shell commands
4. **Package management** - Faster than npm/yarn with built-in lockfile

## Release

### Pre-Release Validation

Run full validation before releasing:

```bash
bun run validate
```

This checks:

- Plugin manifest is valid JSON with required fields
- Versions match across files (package.json, manifest.json, versions.json)
- TypeScript type checking passes
- Code quality checks (Biome + markdownlint) pass
- Build succeeds and produces main.js

### Publishing Steps

1. Update version in `package.json`
2. Run `bun run version` to sync versions
3. Commit: `git add . && git commit -m "chore: bump version to X.Y.Z"`
4. Tag: `git tag X.Y.Z`
5. Push: `git push origin main --follow-tags`
6. GitHub Actions automatically creates release with artifacts

## License

MIT

## Contributing

Contributions are welcome! Please follow these guidelines:

- Use Bun for package management
- Follow the existing code style (Biome formatting)
- Run `bun run validate` before submitting PRs
- Update documentation as needed

## Support

If you encounter issues or have questions:

1. Check the troubleshooting section above
2. Review the developer console for error details
3. Check the [GETTING_STARTED.md](GETTING_STARTED.md) guide
4. Open an issue on GitHub with details and error logs
