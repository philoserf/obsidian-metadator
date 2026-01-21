# Known Issues, Technical Debt & Improvements

## Critical Issues

### 1. API Key Exposure Risk (Medium Priority)

**Status**: Currently acceptable but monitor
**Issue**: API key stored in browser-accessible Obsidian plugin

```typescript
dangerouslyAllowBrowser: true; // Required for plugin architecture
```

**Impact**: If user's vault is compromised, API key could be exposed
**Mitigation**:

- Store in encrypted Obsidian settings (currently done)
- User responsible for vault access control
- Consider implementing API key rotation (future)
  **Resolution**: Inform users to use dedicated API keys, monitor usage

### 2. No Batch Processing

**Status**: Design limitation
**Issue**: Each note requires separate API call
**Impact**: Slow for processing multiple notes, increases cost
**Use Case**: User wants to batch-generate metadata for 100+ notes
**Current Workaround**: Run command multiple times (tedious)
**Future**: Implement batch operation with progress indicator

```typescript
// Not currently supported
async function generateBatch(files: TFile[], settings): Promise<void>;
```

### 3. Content Truncation Limitations

**Status**: Acceptable for current use
**Issue**: Token counting is approximation, not exact
**Impact**: Rare edge cases where content slightly exceeds maxTokens
**Root Cause**: Simple regex-based tokenization, not Claude's official tokenizer
**Mitigation**: Set maxTokens conservatively (default 1000 is safe)
**Future**: Integrate official Claude tokenizer for accuracy

```typescript
// Current approach (approximate)
const tokens = splitIntoTokens(content); // Regex-based

// Ideal approach (accurate)
const count = tokenizer.countTokens(content); // Official SDK
```

## Performance Issues

### 1. Tag Extraction Scans Entire Vault

**Status**: Acceptable, but slow for large vaults
**Issue**: `loadTags()` iterates all markdown files
**Performance**: ~1 second per 100 files on average
**Impact**: User clicks "Extract Tags" button, waits 5-10 seconds for 500+ file vault
**Root Cause**: No indexing or caching
**Mitigation**: Don't use frequently, only once during setup
**Future Improvements**:

- Add progress indicator
- Implement debouncing (prevent rapid clicks)
- Cache results with invalidation strategy
- Use Obsidian's metadata cache more efficiently

### 2. API Call Latency

**Status**: Expected behavior
**Issue**: Claude API calls take 2-10 seconds
**Impact**: User waits while metadata generates
**Mitigation**: Show progress notification ("Generating metadata...")
**Future**:

- Show spinner/progress bar
- Estimate time based on model
- Allow cancellation
- Queue pending operations

### 3. No Caching of Results

**Status**: Design choice
**Issue**: Each run calls Claude, even if content unchanged
**Impact**: Unnecessary API costs if user runs command multiple times on same note
**Rationale**: Keeps system simple, content often changes
**Future**: Optional caching with invalidation based on content hash

## Code Quality Issues

### 1. Limited Error Recovery

**Status**: Basic implementation
**Issue**: Some errors just log and return, no retry logic
**Impact**: Network timeout = metadata generation fails
**Mitigation**: User can retry by running command again
**Future**: Implement exponential backoff retry (already in SDK)

### 2. No Input Validation

**Status**: Acceptable for internal plugin
**Issue**: Prompt templates accept any string
**Impact**: User can break prompt with special characters
**Mitigation**: Unlikely in normal usage
**Future**: Validate and escape user inputs, especially in prompts

### 3. Settings UI Not Responsive

**Status**: Acceptable for current size
**Issue**: All settings rendered at once
**Impact**: Settings page long for small screens
**Future**: Group settings in tabs or collapsible sections

### 4. Insufficient Logging

**Status**: Adequate for debugging
**Issue**: Console logs only for errors and specific debug points
**Impact**: Hard to trace unexpected behavior
**Future**: Add debug mode with comprehensive logging

## Missing Features

### 1. Batch Processing

**Priority**: Medium (requested by power users)
**Description**: Generate metadata for multiple notes at once
**Implementation Complexity**: High
**API Cost Impact**: Optimizable with proper batching
**Estimated Effort**: 2-3 days

### 2. Scheduled Runs

**Priority**: Low
**Description**: Auto-generate metadata on schedule or new file creation
**Limitation**: Obsidian doesn't support scheduled tasks
**Alternative**: Could trigger on file creation, but risky for large vaults

### 3. Dry Run Mode

**Priority**: Medium
**Description**: Preview generated metadata before applying
**Implementation Complexity**: Low
**Estimated Effort**: 1 day

```typescript
// Not currently possible
async function dryRunMetadata(file): Promise<MetadataResponse>;
```

### 4. Custom Prompt per Field

**Priority**: Low
**Description**: Override prompts for specific notes via frontmatter

```yaml
---
tags: manual-tags
metadator-tags-prompt: "Use tech industry jargon"
---
```

### 5. Multiple Claude API Accounts

**Priority**: Very Low
**Description**: Round-robin between API keys to avoid rate limits
**Implementation**: Complex, adds configuration burden
**Estimated Effort**: 3+ days

### 6. Output Formatting Options

**Priority**: Low
**Description**:

- Capitalize tags
- Limit number of tags
- Custom title casing
- Excerpt length for description

```typescript
// Not currently configurable
const tags = metadata.tags.split(","); // Raw, no post-processing
```

## Testing Gaps

### 1. No Automated Tests

**Status**: Manual testing only
**Issue**: No test suite, no CI test runs
**Risk**: Regressions go undetected
**Mitigation**: Code is simple enough for manual review
**Future**: Add Jest/Vitest tests

```bash
# Currently no test runner
npm test  # Not available
```

### 2. No E2E Testing

**Status**: Manual vault testing only
**Issue**: Hard to automate Obsidian plugin testing
**Mitigation**: Sample notes provided for manual testing
**Future**:

- Obsidian testing framework
- Automated vault operations
- API mock testing

### 3. Edge Cases Not Covered

**Issue**: No tests for:

- Empty files
- Files with only frontmatter
- Extremely large files (>1MB)
- Unicode-only content (CJK)
- Files with special characters in name
- Concurrent generation on same file
  **Mitigation**: Manual testing with sample notes

## Compatibility Issues

### 1. Obsidian Mobile Limitations

**Status**: Plugin works on mobile, but:

- API key in password field (accessibility issue)
- Large vault tag extraction might timeout
- No progress indication during operations
  **Mitigation**: Primarily desktop-focused use case

### 2. Special Characters in Tags

**Status**: Mostly working
**Issue**: Some special characters may cause parsing issues
**Impact**: Rare, only if Claude returns invalid YAML characters in tags
**Mitigation**: Validate and escape tag values

### 3. CJK (Chinese/Japanese/Korean) Support

**Status**: Supported via custom tokenization
**Issue**: Truncation methods work but not perfect
**Impact**: CJK content may be over/under-truncated
**Future**: Use official tokenizer that understands CJK properly

## Security Considerations

### 1. API Key Visibility in Settings

**Current**: Password field masks input
**Issue**: Key visible briefly during input/paste
**Mitigation**: User responsible for secure input
**Future**: Allow pasting without displaying

### 2. No Rate Limiting on Vault Tag Extraction

**Issue**: User could click "Extract Tags" repeatedly
**Impact**: Unnecessary vault scans
**Mitigation**: Infrequent operation, unlikely in practice
**Future**: Debounce button with cooldown

### 3. No Content Encryption

**Issue**: Note content sent unencrypted to Anthropic API
**Mitigation**: HTTPS enforced by Anthropic
**User Responsibility**: Understand data is sent to external service

## Maintenance & Documentation

### 1. AGENTS.md Outdated

**Status**: Partially outdated
**Issue**: Some field names changed (e.g., `updateMethod: "no-llm"` vs `"empty_only"`)
**Action**: Update AGENTS.md with current settings interface

### 2. Missing Changelog

**Status**: No CHANGELOG.md
**Issue**: Hard to track what changed between versions
**Future**: Add CHANGELOG following Keep a Changelog format

### 3. Limited API Documentation

**Status**: Code is self-documenting
**Issue**: No detailed API docs for extensibility
**Future**: Add JSDoc comments if plugin becomes extensible

## Performance Optimization Opportunities

### 1. Memoize Tag Extraction

```typescript
// Current: Scans every time
const tags = await loadTags(app);

// Future: Cache with invalidation
const tags = await loadTagsMemoized(app, options);
```

### 2. Parallel Metadata Generation

```typescript
// Current: Single note at a time
await generateMetadata(file);

// Future: Process multiple files in parallel
Promise.all(files.map((f) => generateMetadata(f)));
```

### 3. Streaming Responses

```typescript
// Current: Wait for full response
const message = await anthropic.messages.create({...});

// Future: Stream for faster display
for await (const event of await anthropic.messages.stream({...})) {
  updateUI(event);
}
```

## Risk Assessment

| Issue                      | Severity | Likelihood | Impact           | Status            |
| -------------------------- | -------- | ---------- | ---------------- | ----------------- |
| No batch processing        | Medium   | High       | User frustration | Accepted          |
| API key exposure           | Medium   | Low        | Data breach      | Monitored         |
| Tag extraction slow        | Low      | Medium     | User wait        | Workaround exists |
| Missing tests              | Medium   | Medium     | Regressions      | Accepted for MVP  |
| Token counting approximate | Low      | Low        | Over truncation  | Acceptable        |
| CJK support imperfect      | Low      | Low        | Bad truncation   | Acceptable        |

## Recommendations (Priority Order)

1. **Add dry-run mode** - Low effort, high value
2. **Implement batch processing** - High effort, high value
3. **Add automated tests** - Medium effort, long-term value
4. **Use official tokenizer** - Low effort, medium value
5. **Add progress indicators** - Low effort, medium value
6. **Optimize tag extraction** - Low effort, medium value
7. **Implement custom prompts per note** - Medium effort, low value
8. **Add scheduled runs** - Medium effort, blocked by Obsidian limitations
