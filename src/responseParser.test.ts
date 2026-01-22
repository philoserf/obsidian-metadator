import { describe, expect, it } from "bun:test";
import { parseClaudeResponse } from "./responseParser";

describe("parseClaudeResponse", () => {
  it("should parse valid response with all fields", () => {
    const response = `
      Here's the metadata:
      {
        "tags": "typescript,programming",
        "description": "A guide to TypeScript",
        "title": "TypeScript Guide"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("typescript,programming");
    expect(result.data?.description).toBe("A guide to TypeScript");
    expect(result.data?.title).toBe("TypeScript Guide");
  });

  it("should parse response with partial fields", () => {
    const response = `
      {
        "tags": "design"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("design");
    expect(result.data?.description).toBeUndefined();
    expect(result.data?.title).toBeUndefined();
  });

  it("should parse response with only description and title", () => {
    const response = `
      {
        "description": "A summary",
        "title": "The Title"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.description).toBe("A summary");
    expect(result.data?.title).toBe("The Title");
    expect(result.data?.tags).toBeUndefined();
  });

  it("should fail on missing JSON", () => {
    const response = "No JSON here, just text";
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No JSON");
    expect(result.suggestion).toBeDefined();
  });

  it("should fail on invalid JSON syntax", () => {
    const response = "{tags: 'unquoted-key'}";
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });

  it("should fail on unexpected fields (strict mode)", () => {
    const response = `
      {
        "tags": "design",
        "extra_field": "should fail",
        "another": "field"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });

  it("should fail on wrong field types", () => {
    const response = `
      {
        "tags": ["array", "instead", "of", "string"]
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });

  it("should extract JSON from markdown code blocks", () => {
    const response = `
      \`\`\`json
      {
        "tags": "test,example"
      }
      \`\`\`
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("test,example");
  });

  it("should handle empty string fields", () => {
    const response = `
      {
        "tags": "",
        "description": "",
        "title": ""
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("");
    expect(result.data?.description).toBe("");
  });

  it("should handle special characters in fields", () => {
    const response = `
      {
        "tags": "python,c++,c#",
        "description": "A description with \\"quotes\\" and 'apostrophes'",
        "title": "Title: The Subtitle"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toContain("c++");
    expect(result.data?.description).toContain("quotes");
  });

  it("should extract JSON when surrounded by text", () => {
    const response = `
      Claude says: Here's the analysis
      
      {
        "tags": "analysis,data",
        "description": "Data analysis report"
      }
      
      I hope this helps!
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("analysis,data");
  });

  it("should fail on null values", () => {
    const response = `
      {
        "tags": null
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(false);
  });

  it("should handle whitespace in JSON", () => {
    const response = `
      {
        "tags"  :  "spaced"  ,
        "description"  :  "with spaces"
      }
    `;
    const result = parseClaudeResponse(response);
    expect(result.success).toBe(true);
    expect(result.data?.tags).toBe("spaced");
  });
});
