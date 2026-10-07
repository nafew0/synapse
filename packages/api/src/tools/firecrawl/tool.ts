import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { FirecrawlConfig, FirecrawlScrapeInput, FirecrawlSearchInput } from './client';
import { FIRECRAWL_SEARCH_TOOL_NAME, firecrawlToolkit, isFirecrawlTool } from './definitions';
import { getFirecrawlConfig, scrapeFirecrawl, searchFirecrawl } from './client';

interface ToolRunConfig {
  signal?: AbortSignal;
}

/** Creates the named Firecrawl tool; the API key and limits come from the environment. */
export function createFirecrawlTool(
  toolName: string,
  config: FirecrawlConfig = getFirecrawlConfig(),
): DynamicStructuredTool {
  if (!isFirecrawlTool(toolName)) {
    throw new Error(`Unknown Firecrawl tool: ${toolName}`);
  }
  if (toolName === FIRECRAWL_SEARCH_TOOL_NAME) {
    return tool(
      (input: FirecrawlSearchInput, runConfig?: ToolRunConfig) =>
        searchFirecrawl(config, input, runConfig?.signal),
      firecrawlToolkit.firecrawl_search,
    ) as DynamicStructuredTool;
  }
  return tool(
    (input: FirecrawlScrapeInput, runConfig?: ToolRunConfig) =>
      scrapeFirecrawl(config, input, runConfig?.signal),
    firecrawlToolkit.firecrawl_scrape,
  ) as DynamicStructuredTool;
}
