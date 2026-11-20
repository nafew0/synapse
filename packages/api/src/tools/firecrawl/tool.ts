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
import type { ServiceMeter } from '~/bdren/meter';
import {
  recordServiceCharge,
  firecrawlScrapeCredits,
  firecrawlSearchCredits,
} from '~/usage/charges';
import { FIRECRAWL_SEARCH_TOOL_NAME, firecrawlToolkit, isFirecrawlTool } from './definitions';
import { getFirecrawlConfig, scrapeFirecrawl, searchFirecrawl } from './client';
import { CREDITS_PER_USD } from '~/usage/packages';
import { SERVICE_REFUSAL } from '~/bdren/meter';
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
  /** The allowance meter: a call it cannot cover is refused, and each charged call draws from it. */
  meter?: ServiceMeter | null;
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
    const requestKey = ['firecrawl', ledger.user, ledger.conversationId, ledger.messageId, callId]
      .filter(Boolean)
      .join(':');
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
      requestKey,
    });
    await ledger.meter?.charge(
      requestKey,
      Math.round(credits * ledger.pricePerCreditUsd * CREDITS_PER_USD),
      call === 'search' ? 'web_search' : 'web_scrape',
    );
  };
}

/** The refusal a call gets when the allowance cannot cover its worst-case price, or `undefined`. */
async function refusalFor(
  ledger: FirecrawlLedger | undefined,
  call: FirecrawlCall,
  input: FirecrawlSearchInput | FirecrawlScrapeInput,
): Promise<string | undefined> {
  if (!ledger?.meter) {
    return undefined;
  }
  const units =
    call === 'search'
      ? firecrawlSearchCredits((input as FirecrawlSearchInput).limit ?? 5)
      : firecrawlScrapeCredits();
  const affordable = await ledger.meter.canAfford(
    Math.round(units * ledger.pricePerCreditUsd * CREDITS_PER_USD),
  );
  return affordable ? undefined : SERVICE_REFUSAL;
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
      async (input: FirecrawlSearchInput, runConfig?: ToolRunConfig) =>
        reserveFirecrawlCall(budgetScope, 'search', config) ??
        (await refusalFor(ledger, 'search', input)) ??
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
    async (input: FirecrawlScrapeInput, runConfig?: ToolRunConfig) =>
      reserveFirecrawlCall(budgetScope, 'scrape', config) ??
      (await refusalFor(ledger, 'scrape', input)) ??
      scrapeFirecrawl(
        config,
        input,
        runConfig?.signal,
        reporterFor(ledger, 'scrape', runConfig?.toolCall?.id),
      ),
    firecrawlToolkit.read_web_page,
  ) as DynamicStructuredTool;
}
