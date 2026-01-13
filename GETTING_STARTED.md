# Getting Started

This guide will help you set up and test the Metadator plugin.

## Current Status

The plugin is **fully built and ready to test**! It's already configured in this directory as a test Obsidian vault.

## Quick Start

### 1. Open the Vault in Obsidian

1. Launch Obsidian
2. Click "Open folder as vault" (or "Open another vault")
3. Navigate to and select this project directory: `obsidian-metadata-tool`
4. Obsidian will open with the plugin already loaded

### 2. Configure Your API Key

⚠️ **Important**: You need an Anthropic API key to use this plugin.

1. Get an API key:
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Sign up or log in
   - Add billing information (Claude API requires a paid account)
   - Go to API Keys and create a new key

2. Add the key to the plugin:
   - In Obsidian, open Settings (gear icon in bottom left)
   - Scroll to "Community plugins" section
   - Find "Metadator" and click on it
   - Paste your API key in the "API Key" field
   - The key will be hidden (shown as password dots)

### 3. Test the Plugin

Three sample notes are ready for testing:

1. Open **Sample Note 1.md** (about Obsidian)
2. Press `Cmd/Ctrl + P` to open the command palette
3. Type "metadata" and select "Generate metadata for current note"
4. Watch as the plugin:
   - Analyzes the content
   - Generates tags, description, and title
   - Updates the frontmatter

The note should now have frontmatter like this:

```yaml
---
tags:
  - obsidian
  - knowledge-management
  - note-taking
description: A guide to getting started with Obsidian's key features
title: Getting Started with Obsidian
---
```

### 4. Try the Other Sample Notes

- **Sample Note 2.md** - About morning routines (lifestyle/productivity)
- **Sample Note 3.md** - About machine learning (technical/education)

Each should generate appropriate metadata based on its content.

## Customizing the Plugin

### Settings You Can Adjust

#### API Settings

- **Model**: Choose which Claude model to use
  - Sonnet 4.5: Balanced (recommended)
  - Opus 4.5: Most capable but slower/expensive
  - Sonnet 3.7: Good balance
  - Haiku 3.5: Fastest and cheapest

#### Update Method

- **Force Update**: Always regenerate all fields
- **Update Empty Only**: Only fill in missing fields (default)

#### Content Truncation

- Enable to limit content sent to API (saves money)
- Adjust max tokens (default: 1000)
- Choose truncation method:
  - Beginning Only: Send first N tokens
  - Beginning + End: Send start and end
  - Headings: Send outline + snippets

#### Field Names

- Customize what the frontmatter fields are called
- Default: tags, description, title

#### Prompts

- Customize instructions for each type of metadata
- Tell Claude how to select tags, write descriptions, and create titles

#### Tags

- Define preferred tags
- Click "Extract" to pull existing tags from your vault
- Claude can also create new tags if none fit

#### Custom Metadata

- Add any additional key-value pairs
- Example: `author: Your Name` or `draft: true`

## Development Workflow

If you want to modify the plugin:

1. Make changes to files in `src/`
2. Run `bun run dev` for watch mode (auto-rebuild)
3. In Obsidian, reload the plugin:
   - Press `Cmd/Ctrl + R` to reload Obsidian
   - Or Settings → Community plugins → disable and re-enable

See [DEVELOPMENT.md](DEVELOPMENT.md) for detailed development instructions.

## Troubleshooting

### Plugin not appearing

- Make sure you selected this folder as a vault in Obsidian
- Check Settings → Community plugins is enabled
- The plugin should appear in the list automatically

### "Please configure your Anthropic API key"

- You haven't added an API key yet
- Go to Settings → Metadator and add your key
- Make sure you have billing enabled on your Anthropic account

### "Authentication failed"

- Your API key is incorrect or invalid
- Copy a fresh key from console.anthropic.com
- Make sure there are no extra spaces when pasting

### "Rate limit exceeded"

- You're making requests too quickly
- Wait a moment and try again
- Consider using Haiku 3.5 for faster/cheaper requests

### No metadata generated

- Check the Developer Console (Cmd/Ctrl + Shift + I) for errors
- Make sure the note has content
- Try enabling "Force Update" in settings

### Changes not appearing

- Make sure you saved the settings
- Try disabling and re-enabling the plugin
- Reload Obsidian (Cmd/Ctrl + R)

## Next Steps

- Create your own notes and test the metadata generation
- Customize the categories and tags to match your vault
- Adjust the prompts to get the metadata style you want
- Set up keyboard shortcuts for the command in Obsidian settings

## Need Help?

- Check the [README.md](README.md) for features overview
- See [DEVELOPMENT.md](DEVELOPMENT.md) for technical details
- Review the console logs for detailed error messages
