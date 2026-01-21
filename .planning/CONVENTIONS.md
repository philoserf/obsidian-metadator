# Code Conventions & Patterns

## Style & Formatting

### Indentation & Spacing

- **2-space indent** (enforced by Biome)
- No tabs
- Trailing whitespace removed
- Consistent spacing around operators

### Imports

- Organized by Biome's import sorting
- Separate groups: types vs. values
- Type imports use `type` keyword

  ```typescript
  import { Plugin } from "obsidian";
  import type { App } from "obsidian";
  ```

- No unused imports (auto-removed)
- Alphabetical within groups

### Code Style

- **Template literals** preferred over string concatenation
- **Arrow functions** for callbacks
- **const** by default, `let` only when reassignment needed
- Type annotations required (strict mode)
- Semicolons required
- Single quotes preferred for strings
- Double quotes for JSX/HTML attributes (N/A here)

### Line Length

- Soft limit ~80-100 characters
- Break at logical boundaries (commas, operators)

### Variable Naming

- **camelCase** for variables, functions, properties
- **PascalCase** for classes, interfaces, types
- **UPPER_SNAKE_CASE** for constants (rare in this codebase)
- Descriptive names over abbreviations
  - ✅ `truncateMethod`
  - ❌ `tm`
  - ✅ `maxTokens`
  - ❌ `max`

### Function Naming

- **Verb-based names** for functions
  - `generateMetadata()`, `callClaude()`, `getContent()`
  - `updateFrontMatter()`, `loadTags()`, `formatDate()`
- Descriptive return types explicitly annotated
- Promise-returning functions marked `async`

## Type System (TypeScript)

### Interface Design

- **Prefix with "I"** not used (convention not followed here)
- Exported with `export interface`
- Used for plugin settings, API responses

  ```typescript
  export interface MetadataToolSettings {
    apiKey: string;
    // ...
  }
  ```

### Type Annotations

- Function parameters fully typed
- Return types explicitly annotated

  ```typescript
  export async function generateMetadata(
    app: App,
    settings: MetadataToolSettings,
  ): Promise<void> {
    // ...
  }
  ```

- Avoid `any` type (strict mode prevents it)
- Use `unknown` for truly unknown types, then narrow

### Union Types

- Used for fixed options

  ```typescript
  updateMethod: "force" | "no-llm";
  truncateMethod: "head_only" | "head_tail" | "heading";
  ```

- More readable than enums for small sets

### Default Values

- Centralized in `DEFAULT_SETTINGS` constant
- Typed as part of interface
- Merged at runtime: `Object.assign({}, DEFAULT_SETTINGS, loaded)`

## Error Handling

### Pattern

```typescript
try {
  // Operation that might fail
  const result = await callClaude(content, settings);
} catch (error) {
  // User notification
  if (error instanceof Error) {
    new Notice(`Error: ${error.message}`);
  }
  // Detailed logging
  console.error("Operation error:", error);
  // Re-throw or return gracefully
  throw error;
}
```

### Error Messages

- User-facing: Short, actionable, specific
  - "Please open a file first"
  - "Current file is not a markdown file"
  - "Please configure your Anthropic API key"
- Console logs: Detailed context
  - "Metadata generation check: {...}"
  - "Claude API error:", error

### User Notifications

- Via `new Notice()` from Obsidian API
- Long-duration for important messages: `new Notice(msg, 8000)`
- No notifications for expected flow (no unnecessary spam)

## Comments & Documentation

### Comment Usage

- **Minimal in-code comments** (code should be self-documenting)
- Used for:
  - Explaining "why" (business logic, non-obvious decisions)
  - Workarounds for quirks or limitations
  - Complex algorithms (truncation methods)

### Example

```typescript
// Check if we need to call Claude for metadata
const needsMetadata =
  !frontMatter[settings.tagsFieldName] ||
  // ... (conditions are self-explanatory via names)
```

### No Doc Comments

- Functions are self-documenting via names and types
- Interfaces have field names that explain purpose
- No JSDoc style comments (kept minimal)

## Logging

### Debug Logging

```typescript
console.log("Metadata generation check:", {
  needsMetadata,
  hasTags: !!frontMatter[settings.tagsFieldName],
  // Structured log with context
});
```

### Error Logging

```typescript
console.error("Error generating metadata with Claude:", error);
```

### Guidelines

- Use object notation for structured data
- Include context (variable states, flow state)
- Error logs include the Error object
- No logging of sensitive data (API keys)

## Function Structure

### Typical Pattern

1. Input validation
2. Extract/prepare data
3. Main operation
4. Error handling
5. State update/notification
6. Return result

### Example (generateMetadata)

```typescript
// 1. Validate
const file = app.workspace.getActiveFile();
if (!file) return;

// 2. Extract
const fm = app.metadataCache.getFileCache(file);
const needsMetadata = /* check conditions */;

// 3. Main operation
if (needsMetadata) {
  await addMetadataWithClaude(...);
}

// 4. Error handling (in try-catch wrapper)
// 5. Notification
new Notice("Metadata updated successfully");
```

## Async/Await Patterns

### Promise-based

- All async operations use `async/await`
- No `.then()` chains
- Error handling via try-catch

  ```typescript
  async function generateMetadata(...): Promise<void> {
    try {
      // ...
    } catch (error) {
      // ...
    }
  }
  ```

### Void Returns

- Main command callbacks return `Promise<void>`
- No value needs to be returned
- Side effects (notifications, file updates) are main purpose

## Obsidian API Patterns

### Command Registration

```typescript
this.addCommand({
  id: "generate-metadata",
  name: "Generate metadata for current note",
  callback: async () => {
    await generateMetadata(this.app, this.settings);
  },
});
```

### Settings Handling

```typescript
// Loading
this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

// Saving
await this.saveData(this.settings);
```

### Frontmatter Processing

```typescript
app.fileManager.processFrontMatter(file, (frontmatter) => {
  frontmatter[key] = value;
  // Changes are atomic, committed after callback
});
```

### File Operations

```typescript
const content = await app.vault.read(file);
const cache = app.metadataCache.getFileCache(file);
const tags = getAllTags(cache);
```

## Content Processing

### Token Splitting

```typescript
const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[.,!?;...]/g;
const tokens = str.match(regex);
```

- Supports Chinese characters (contiguous blocks)
- Supports English words (contiguous blocks)
- Supports punctuation (individual tokens)
- Supports newlines

### Truncation Methods

```typescript
if (method === "head_only") {
  // First N tokens
} else if (method === "head_tail") {
  // 80% front + 20% end
} else if (method === "heading") {
  // Headings + summaries
}
```

## Settings UI Patterns

### Setting Groups

```typescript
new Setting(containerEl).setName("Section").setHeading();
// ... multiple settings in section
```

### Text Input

```typescript
new Setting(containerEl)
  .setName("Label")
  .setDesc("Description")
  .addText((text) => {
    text
      .setPlaceholder("...")
      .setValue(...)
      .onChange(async (value) => {
        this.plugin.settings.field = value;
        await this.plugin.saveSettings();
      });
  });
```

### Dropdown

```typescript
.addDropdown((dropdown) =>
  dropdown
    .addOption("value1", "Display 1")
    .addOption("value2", "Display 2")
    .setValue(...)
    .onChange(async (value) => { /* ... */ })
);
```

### Toggle

```typescript
.addToggle((toggle) =>
  toggle
    .setValue(...)
    .onChange(async (value) => { /* ... */ })
);
```

### TextArea

```typescript
.addTextArea((text) => {
  tagsTextArea = text; // Store ref for later
  text
    .setValue(...)
    .onChange(async (value) => { /* ... */ });
  text.inputEl.setAttr("rows", "7");
});
```

## Testing & Validation

### No Automated Tests

- Currently no test files (test runners available)
- Manual testing in Obsidian vault
- Sample notes provided for testing
- Pre-release validation via `bun run validate`

### Code Quality Checks

- `bun run check`: Run Biome + markdownlint
- `bun run typecheck`: TypeScript compiler
- `bun run lint:fix`: Auto-fix linting issues

### Validation Before Release

```bash
bun run validate
# Checks:
# - manifest.json format
# - versions.json consistency
# - TypeScript compilation
# - Biome checks
# - Build succeeds
```

## Dependencies & Imports

### Obsidian Imports

```typescript
import { Plugin, Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, TFile } from "obsidian";
```

### Anthropic Imports

```typescript
import Anthropic from "@anthropic-ai/sdk";
```

### Local Imports

```typescript
import { generateMetadata } from "./metadata";
import type { MetadataToolSettings } from "./settings";
```

## Release & Versioning

### Version Management

- Semantic versioning in package.json
- `bun run version` syncs to manifest.json and versions.json
- GitHub Actions creates release with artifacts

### Pre-release Checklist

- Update package.json version
- Run `bun run validate`
- Commit with message "chore: bump version to X.Y.Z"
- Tag with version number
- Push with `--follow-tags`

## Performance Considerations

### Content Truncation

- Reduces API cost and latency
- Three strategies for different content types
- Token-based limiting (not character-based)

### Tag Extraction

- Scans entire vault (potentially slow for large vaults)
- Runs on-demand via button click
- Could be optimized with debouncing/caching

### API Calls

- Called per note (not batch)
- Max response tokens: 2048
- Timeout implicit in Anthropic SDK
