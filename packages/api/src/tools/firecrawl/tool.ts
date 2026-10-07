import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { FirecrawlConfig, FirecrawlScrapeInput, FirecrawlSearchInput } from './client';
import { FIRECRAWL_SEARCH_TOOL_NAME, firecrawlToolkit, isFirecrawlTool } from './definitions';
import { getFirecrawlConfig, scrapeFirecrawl, searchFirecrawl } from './client';
import { reserveFirecrawlCall } from './budget';

interface ToolRunConfig {
  signal?: AbortSignal;
}

export interface FirecrawlToolOptions {
  config?: FirecrawlConfig;
  /** Object that lives for one user turn (the request); calls made under it share one budget. */
  budgetScope?: object;
}

/** Creates the named Firecrawl tool; the API key, limits and budget come from the environment. */
export function createFirecrawlTool(
  toolName: string,
  { config = getFirecrawlConfig(), budgetScope = {} }: FirecrawlToolOptions = {},
): DynamicStructuredTool {
  if (!isFirecrawlTool(toolName)) {
    throw new Error(`Unknown Firecrawl tool: ${toolName}`);
  }
  if (toolName === FIRECRAWL_SEARCH_TOOL_NAME) {
    return tool(
      (input: FirecrawlSearchInput, runConfig?: ToolRunConfig) =>
        reserveFirecrawlCall(budgetScope, 'search', config) ??
        searchFirecrawl(config, input, runConfig?.signal),
      firecrawlToolkit.firecrawl_search,
    ) as DynamicStructuredTool;
  }
  return tool(
    (input: FirecrawlScrapeInput, runConfig?: ToolRunConfig) =>
      reserveFirecrawlCall(budgetScope, 'scrape', config) ??
      scrapeFirecrawl(config, input, runConfig?.signal),
    firecrawlToolkit.firecrawl_scrape,
  ) as DynamicStructuredTool;
}
