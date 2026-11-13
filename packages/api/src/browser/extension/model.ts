import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { BrowserExtensionMethods } from '@librechat/data-schemas';
import type { ExtensionConfig } from './config';
import type { ExtensionRequest } from './auth';

/** What the extension sends as the model name; Synapse ignores it and uses its own. */
export const EXTENSION_MODEL_NAME = 'synapse';
/** How much of a streamed answer is kept to read the usage at its end. */
const USAGE_TAIL_BYTES = 32_000;

export type UsageStore = Pick<
  BrowserExtensionMethods,
  'recordBrowserExtensionUsage' | 'sumBrowserExtensionTokens'
>;

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

type ChatBody = Record<string, unknown> & { stream?: boolean };

/** The part of `fetch` the endpoint uses, so a test can stand in for the provider. */
export type FetchLike = (url: string, init: RequestInit) => Promise<globalThis.Response>;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The request as the provider gets it: Synapse's model, capped output, and usage reported back. */
export function prepareBody(body: ChatBody, config: ExtensionConfig): ChatBody {
  const cap = (value: unknown): number =>
    typeof value === 'number' && value > 0
      ? Math.min(value, config.maxOutputTokens)
      : config.maxOutputTokens;
  const prepared: ChatBody = { ...body, model: config.model, usage: { include: true } };
  if ('max_completion_tokens' in body)
    prepared.max_completion_tokens = cap(body.max_completion_tokens);
  else prepared.max_tokens = cap(body.max_tokens);
  if (body.stream) prepared.stream_options = { include_usage: true };
  return prepared;
}

/** The last usage report in a streamed answer's tail. */
export function usageFromStream(tail: string): ProviderUsage | null {
  const lines = tail.split('\n').reverse();
  for (const line of lines) {
    const text = line.replace(/^data:\s*/, '').trim();
    if (!text.startsWith('{') || !text.includes('"usage"')) continue;
    try {
      const usage = (JSON.parse(text) as { usage?: ProviderUsage }).usage;
      if (usage) return usage;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ModelHandlers {
  listModels: (req: ExtensionRequest, res: Response) => void;
  chatCompletions: (req: ExtensionRequest, res: Response) => Promise<void>;
}

export function createModelHandlers(deps: {
  config: () => ExtensionConfig;
  store: UsageStore;
  fetch?: FetchLike;
  now?: () => Date;
}): ModelHandlers {
  const send: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => new Date());

  const record = async (req: ExtensionRequest, usage: ProviderUsage | null): Promise<void> => {
    if (!usage || !req.user) return;
    await deps.store
      .recordBrowserExtensionUsage({
        user: req.user._id,
        tenantId: req.user.tenantId,
        llmModel: deps.config().model,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        costUsd: usage.cost ?? 0,
        at: now(),
      })
      .catch((error) => logger.error('[browserExtension] usage not recorded', error));
  };

  const listModels = (_req: ExtensionRequest, res: Response): void => {
    res.json({ object: 'list', data: [{ id: EXTENSION_MODEL_NAME, object: 'model' }] });
  };

  /** Forwards a chat completion to the provider. Page text, screenshots and answers pass through and are not stored. */
  const chatCompletions = async (req: ExtensionRequest, res: Response): Promise<void> => {
    const config = deps.config();
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: 'signed_out', message: 'Sign in to Synapse again.' } });
      return;
    }
    const used = await deps.store.sumBrowserExtensionTokens(user._id, startOfUtcDay(now()));
    if (used >= config.dailyTokens) {
      res.status(429).json({
        error: {
          code: 'daily_limit',
          message: "You have reached today's limit for browser tasks. It resets at 00:00 UTC.",
        },
      });
      return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const body = prepareBody((req.body ?? {}) as ChatBody, config);
    let upstream: globalThis.Response;
    try {
      upstream = await send(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (error) {
      logger.error(
        '[browserExtension] model provider unreachable',
        error instanceof Error ? error.message : '',
      );
      res
        .status(502)
        .json({ error: { message: 'The model service is unavailable. Try again later.' } });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      logger.warn(`[browserExtension] provider answered ${upstream.status}`);
      res.status(upstream.status).type('application/json').send(detail);
      return;
    }
    if (!body.stream) {
      const payload = (await upstream.json()) as { usage?: ProviderUsage };
      await record(req, payload.usage ?? null);
      res.json(payload);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        tail = (tail + decoder.decode(value, { stream: true })).slice(-USAGE_TAIL_BYTES);
      }
    } catch (error) {
      if (!abort.signal.aborted)
        logger.warn(
          '[browserExtension] stream ended early',
          error instanceof Error ? error.message : '',
        );
    }
    res.end();
    await record(req, usageFromStream(tail));
  };

  return { listModels, chatCompletions };
}
