import { randomUUID } from 'crypto';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type {
  FirecrawlConfig,
  FirecrawlScrapeInput,
  FirecrawlSearchInput,
  FirecrawlCreditsReporter,
} from './client';
import type { FirecrawlBudgetScope, FirecrawlCall } from './budget';
import { FIRECRAWL_SEARCH_TOOL_NAME, firecrawlToolkit, isFirecrawlTool } from './definitions';
import { getFirecrawlConfig, scrapeFirecrawl, searchFirecrawl } from './client';
import { recordServiceCharge } from '~/usage/charges';
import { reserveFirecrawlCall } from './budget';

interface ToolRunConfig {
  signal?: AbortSignal;
  toolCall?: { id?: string };
}

/** Who a Firecrawl call is billed to in the ledger, and at what price. */
export interface FirecrawlLedger {
  user: string;
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
  pricePerCreditUsd: number;
}

export interface FirecrawlToolOptions {
  config?: FirecrawlConfig;
  /** Calls made under the same scope share one budget; see `resolveFirecrawlBudgetScope`. */
  budgetScope?: FirecrawlBudgetScope;
  /** When set, each call that returns a document writes a ledger row. */
  ledger?: FirecrawlLedger;
}

function reporterFor(
  ledger: FirecrawlLedger | undefined,
  call: FirecrawlCall,
  toolCallId?: string,
): FirecrawlCreditsReporter | undefined {
  if (!ledger) {
    return undefined;
  }
  const callId = toolCallId ?? randomUUID();
  return async (credits) => {
    await recordServiceCharge({
      service: 'firecrawl',
      usageKind: call === 'search' ? 'web_search' : 'web_scrape',
      usageUnit: 'operations',
      units: credits,
      unitPriceUsd: ledger.pricePerCreditUsd,
      user: ledger.user,
      tenantId: ledger.tenantId,
      conversationId: ledger.conversationId,
      messageId: ledger.messageId,
      requestKey: ['firecrawl', ledger.user, ledger.conversationId, ledger.messageId, callId]
        .filter(Boolean)
        .join(':'),
    });
  };
}

/** Creates the named Firecrawl tool; the API key, limits and budget come from the environment. */
export function createFirecrawlTool(
  toolName: string,
  { config = getFirecrawlConfig(), budgetScope = {}, ledger }: FirecrawlToolOptions = {},
): DynamicStructuredTool {
  if (!isFirecrawlTool(toolName)) {
    throw new Error(`Unknown Firecrawl tool: ${toolName}`);
  }
  if (toolName === FIRECRAWL_SEARCH_TOOL_NAME) {
    return tool(
      (input: FirecrawlSearchInput, runConfig?: ToolRunConfig) =>
        reserveFirecrawlCall(budgetScope, 'search', config) ??
        searchFirecrawl(
          config,
          input,
          runConfig?.signal,
          reporterFor(ledger, 'search', runConfig?.toolCall?.id),
        ),
      firecrawlToolkit.search_web,
    ) as DynamicStructuredTool;
  }
  return tool(
    (input: FirecrawlScrapeInput, runConfig?: ToolRunConfig) =>
      reserveFirecrawlCall(budgetScope, 'scrape', config) ??
      scrapeFirecrawl(
        config,
        input,
        runConfig?.signal,
        reporterFor(ledger, 'scrape', runConfig?.toolCall?.id),
      ),
    firecrawlToolkit.read_web_page,
  ) as DynamicStructuredTool;
}
