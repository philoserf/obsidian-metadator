#!/bin/bash

# Setup script for Obsidian test vault

echo "Setting up Obsidian test vault..."

# Create necessary directories
mkdir -p .obsidian/plugins/obsidian-metadata-tool

# Build the plugin
echo "Building plugin..."
bun run build

# Create symlinks
echo "Creating symlinks..."
cd .obsidian/plugins/obsidian-metadata-tool
rm -f main.js manifest.json
ln -s ../../../dist/main.js main.js
ln -s ../../../manifest.json manifest.json
cd ../../..

echo "✓ Vault setup complete!"
echo ""
echo "Next steps:"
echo "1. Open this folder as a vault in Obsidian"
echo "2. Go to Settings → Community Plugins and enable 'Metadata Tool'"
echo "3. Configure your Anthropic API key in plugin settings"
echo "4. Try the plugin on one of the Sample notes"
