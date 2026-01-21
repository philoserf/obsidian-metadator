# System Architecture

## Overview

Metadator is an Obsidian plugin that automatically generates metadata (tags, descriptions, titles) for Markdown notes using Claude AI. It integrates with Obsidian's plugin API and the Anthropic SDK to provide intelligent metadata generation.

## Core Components

### 1. Plugin Entry Point (main.ts)

**Responsibility**: Plugin lifecycle management

- Extends Obsidian's `Plugin` class
- Loads/saves settings on plugin load
- Registers "Generate metadata for current note" command
- Creates and displays settings tab

**Flow**:

1. `onload()` → Initialize plugin
2. Register command callback
3. Load user settings
4. Mount settings UI

### 2. Metadata Generation (metadata.ts)

**Responsibility**: Orchestrate Claude API calls and frontmatter updates

- Main entry point: `generateMetadata(app, settings)`
- Validates file type (must be Markdown)
- Checks API key configuration
- Determines if metadata update is needed
- Calls Claude API with content
- Parses JSON response
- Updates frontmatter with generated metadata

**Key Decision**: Update method

- **"force"**: Always update fields
- **"no-llm"**: Only update empty fields (default)

**Metadata Fields**:

- Tags (array) - append existing tags
- Description (string) - update or keep existing
- Title (string) - update or keep existing (optional)
- Custom metadata - add static key-value pairs

### 3. Claude API Integration (utils.ts: callClaude)

**Responsibility**: Handle Anthropic SDK communication

- Initialize Anthropic client with user's API key
- Send truncated content + prompt to Claude
- Handle streaming responses
- Provide user-friendly error messages
- User notification for API errors (auth, rate limit, overloaded)

**Error Handling**:

- `authentication_error`: Invalid API key
- `rate_limit`: Rate limit exceeded
- `overloaded`: API overloaded
- Generic: Unknown error

### 4. Content Management (utils.ts)

**Responsibility**: Read, truncate, and process note content

**Key Functions**:

- `getContent()`: Extract content from current note
  - Support for truncation methods: head_only, head_tail, heading
  - Unicode/Chinese character handling via token splitting
  - Limit content by token count
- `updateFrontMatter()`: Modify note's YAML frontmatter
  - Methods: append (for tags), update, keep (skip if exists)
  - Type conversion (string → boolean for true/false values)
  - Array uniqueness for tags

- `loadTags()`: Extract existing tags from vault
  - Scan all markdown files in vault
  - Build tag frequency map
  - Filter tags by occurrence count

### 5. Settings Management (settings.ts, settingsTab.ts)

**Responsibility**: Configuration interface and persistence

**Settings Structure**:

- API credentials (key, model)
- Field names (tags, description, title)
- Truncation settings (method, max tokens)
- Prompt templates (customizable per field)
- Custom metadata pairs
- Feature toggles (enable title, truncate content)
- Update behavior (force vs. empty-only)

**Settings UI** (settingsTab.ts):

- Password-masked API key input
- Model dropdown with 4 options
- Toggle controls for features
- Text area for prompts
- Extract tags button (vault scan)
- Custom metadata field builder

## Data Flow

```text
User opens note
    ↓
Command "Generate metadata" triggered
    ↓
generateMetadata() validates:
  - File is markdown
  - API key configured
  - Metadata needs update
    ↓
getContent() truncates content
    ↓
callClaude() sends prompt + content
    ↓
Claude AI generates JSON response
    ↓
Parse JSON response
    ↓
updateFrontMatter() updates:
  - Tags (append)
  - Description (update or keep)
  - Title (if enabled)
  - Custom metadata
    ↓
Success notification
```

## Content Truncation Strategies

### head_only

- First N tokens of content
- Fastest, simplest
- Best for: Articles with key info up front

### head_tail

- 80% from beginning + 20% from end
- Preserves summary context
- Best for: Long documents with conclusion

### heading

- Document outline (headings only)
- First paragraph per section
- Best for: Structured documents with clear sections

## Plugin Lifecycle

1. **Load**:
   - Load settings from Obsidian storage
   - Register command
   - Mount settings UI

2. **User Action**:
   - Open note
   - Run "Generate metadata" command

3. **Execution**:
   - Validate inputs
   - Fetch content (with truncation)
   - Call Claude API
   - Update frontmatter
   - Show notification

4. **Error Recovery**:
   - User-friendly error messages
   - Log detailed errors to console
   - Graceful exit without crashing

## Integration Points

### Obsidian API

- `app.workspace.getActiveFile()` - Current note
- `app.metadataCache.getFileCache()` - Frontmatter/tags
- `app.vault.read()` - File content
- `app.fileManager.processFrontMatter()` - Update frontmatter
- `app.vault.getMarkdownFiles()` - All notes (for tag extraction)

### Anthropic API

- Messages endpoint for text generation
- Model selection (Sonnet, Opus, Haiku)
- Max tokens parameter (2048 for response)

## Security Considerations

- API key stored securely in Obsidian's settings
- Password-masked input in UI
- No logging of sensitive data
- Browser-compatible SDK (`dangerouslyAllowBrowser: true`)
