import type { App, TFile } from "obsidian";
import type { MetadataToolSettings } from "../settings";
import { splitIntoTokens } from "./tokens";
import {
  truncateHeading,
  truncateHeadOnly,
  truncateHeadTail,
} from "./truncate";

export async function getContent(
  app: App,
  file: TFile,
  limit: number = 1000,
  method: MetadataToolSettings["truncateMethod"] = "head_only",
): Promise<string> {
  let contentStr = await app.vault.read(file);

  if (contentStr.length === 0) {
    return "";
  }

  if (limit <= 0) {
    return contentStr;
  }

  const tokens = splitIntoTokens(contentStr);

  if (tokens.length > limit) {
    if (method === "head_tail") {
      contentStr = truncateHeadTail(tokens, limit);
    } else if (method === "head_only") {
      contentStr = truncateHeadOnly(tokens, limit);
    } else if (method === "heading") {
      contentStr = truncateHeading(contentStr, tokens, limit);
    }
  }

  return contentStr;
}
