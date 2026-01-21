# External Integrations

## Anthropic Claude API

### Service Details

- **Provider**: Anthropic
- **SDK**: @anthropic-ai/sdk (v0.71.2)
- **Authentication**: API key (user-provided)
- **Endpoint**: REST API (<https://api.anthropic.com>)
- **Configuration**: Browser-compatible mode enabled

### Integration Points

#### 1. API Client Initialization

**File**: src/utils.ts (callClaude function)

```typescript
const anthropic = new Anthropic({
  apiKey: settings.anthropicApiKey,
  dangerouslyAllowBrowser: true,
});
```

#### 2. Message Creation

**Endpoint**: `POST /v1/messages`
**Parameters**:

- `model`: User-selected model (claude-sonnet-4-5-20250929, etc.)
- `max_tokens`: 2048 (fixed)
- `messages`: Array with user role + prompt content
- `stream`: Not used (synchronous call)

**Request Format**:

```typescript
const message = await anthropic.messages.create({
  model: settings.anthropicModel,
  max_tokens: 2048,
  messages: [{ role: "user", content: prompt }],
});
```

**Response Format**:

```typescript
{
  id: string,
  type: "message",
  role: "assistant",
  content: [
    {
      type: "text",
      text: "..."  // JSON response with tags, description, title
    }
  ],
  model: string,
  stop_reason: string,
  stop_sequence: null,
  usage: {
    input_tokens: number,
    output_tokens: number
  }
}
```

### Supported Models

```text
claude-sonnet-4-5-20250929  (default, recommended)
claude-opus-4-5-20251101    (most capable, higher cost)
claude-haiku-4-5-20251001   (fastest, cheapest)
```

### Error Handling

The SDK provides structured error types:

- `authentication_error`: Invalid API key
- `rate_limit_error`: Too many requests
- `overloaded_error`: API overloaded
- `invalid_request_error`: Bad request format

**Handling in Plugin**:

```typescript
if (error.message.includes("authentication_error")) {
  // Direct user to Settings with helpful message
} else if (error.message.includes("rate_limit")) {
  // Ask user to wait and retry
} else if (error.message.includes("overloaded")) {
  // Ask user to retry later
}
```

### Cost Implications

- **Input tokens**: Charged per model
  - Sonnet: ~$3 per 1M input tokens
  - Opus: ~$15 per 1M input tokens
  - Haiku: ~$0.80 per 1M input tokens
- **Output tokens**: 2-3x input cost
- **Typical usage**: 500-2000 tokens per note
- **Cost per note**: $0.01 - $0.10 (Sonnet)

### Optimization Features

Content truncation reduces input tokens:

- **head_only**: ~500 tokens typical
- **head_tail**: ~600 tokens typical
- **heading**: ~300-400 tokens typical
- No truncation: Unlimited (can be expensive)

## Obsidian Plugin API

### Core APIs Used

#### Plugin Class

**File**: src/main.ts

```typescript
export default class MetadataToolPlugin extends Plugin {
  // Inherited from obsidian.Plugin
  async onload();
  async onunload();
  async loadData();
  async saveData();
}
```

#### File Operations

**File**: src/metadata.ts

```typescript
app.workspace.getActiveFile(); // Get current note
app.metadataCache.getFileCache(); // Get metadata cache
app.vault.read(file); // Read file content
app.fileManager.processFrontMatter(); // Update YAML frontmatter
```

#### Metadata Cache

**File**: src/metadata.ts, src/utils.ts

```typescript
const fm = app.metadataCache.getFileCache(file);
const tags = getAllTags(fm); // Extract all tags from file
```

#### Vault Operations

**File**: src/utils.ts

```typescript
app.vault.getMarkdownFiles(); // Get all markdown files (for tag extraction)
```

### UI Components

**File**: src/settingsTab.ts

```typescript
PluginSettingTab; // Base class for settings UI
Setting; // Individual setting control
Notice; // Toast notifications
```

**Component Types**:

- Text input: `.addText()`
- Dropdown: `.addDropdown()`
- Toggle: `.addToggle()`
- TextArea: `.addTextArea()`
- Button: `.addButton()`
- Heading: `.setHeading()`

### Command Registration

**File**: src/main.ts

```typescript
this.addCommand({
  id: "generate-metadata",
  name: "Generate metadata for current note",
  callback: async () => {
    /* ... */
  },
});
```

### Settings Persistence

**Storage**: Obsidian plugin data storage

```typescript
// Load
const data = await this.loadData();
this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

// Save
await this.saveData(this.settings);
```

### Minimum Requirements

- **Minimum Obsidian Version**: 1.0.0
- **Architecture**: All platforms (desktop, mobile)
- **No special permissions**: Uses standard Obsidian APIs

## Development Environment

### GitHub Actions

**File**: .github/workflows/

Automated CI/CD for:

- Running checks (Biome, markdownlint, TypeScript)
- Building plugin
- Creating releases with artifacts
- Publishing to Obsidian community

### Build Tools

- **Bun**: Package manager and build runner
- **TypeScript**: Language and type checking
- **Biome**: Code formatter and linter
- **markdownlint**: Documentation linting

### External Files

- manifest.json: Auto-synced with package.json
- versions.json: Maps versions to min Obsidian versions
- main.js: Compiled plugin output

## Data Flow with External Services

```text
User enters API key
    ↓
Plugin stores in Obsidian settings (encrypted at rest)
    ↓
User selects model + settings
    ↓
User runs "Generate metadata" command
    ↓
Plugin extracts note content (from Obsidian vault)
    ↓
Plugin creates prompt + truncates content
    ↓
Plugin calls Claude API with Anthropic SDK
    ↓
Claude AI generates JSON response
    ↓
Plugin parses response
    ↓
Plugin updates note's frontmatter via Obsidian API
    ↓
Obsidian saves file automatically
    ↓
User sees success notification
```

## API Rate Limits

### Anthropic API Tier Limits

Depends on user's API key billing tier:

- **Free tier**: Very limited (for testing)
- **Starter**: ~500 requests/minute
- **Production**: Higher with rate limiting headers

**Handling**: SDK automatically retries with exponential backoff

### Recommended Usage

- Batch operations: Not currently supported (per-note basis)
- Rate limiting: Implement queue if processing multiple notes
- Caching: Could cache results per note (not currently implemented)

## Security & Privacy

### API Key Storage

- Stored in Obsidian's encrypted settings storage
- Password-masked in UI
- Never logged or exposed in errors
- Only sent to Anthropic API

### Content Privacy

- Note content sent to Anthropic for processing
- Anthropic retains data for 30 days by default
- User can request deletion from Anthropic

### User Data

- No data stored on external servers
- No analytics or tracking
- All processing local to Obsidian + API calls

## Configuration Files

### manifest.json

```json
{
  "id": "metadator",
  "name": "Metadator",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "...",
  "author": "Mark Ayers",
  "authorUrl": "https://github.com/markayers"
}
```

### versions.json

```json
{
  "1.0.0": "1.0.0"
}
```

Auto-updated to maintain compatibility mapping.
