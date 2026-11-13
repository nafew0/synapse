import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { BrowserExtensionMethods } from '@librechat/data-schemas';
import type { ExtensionConfig } from './config';
import type { ExtensionRequest } from './auth';

/** What the extension sends as the model name; Synapse ignores it and uses its own. */
export const EXTENSION_MODEL_NAME = 'synapse';
/** How much of a streamed answer is kept to read the usage at its end. */
const USAGE_TAIL_BYTES = 32_000;

export type UsageStore = Pick<
  BrowserExtensionMethods,
  'recordBrowserExtensionUsage' | 'settleBrowserExtensionUsage' | 'sumBrowserExtensionTokens'
>;

/**
 * The request fields the endpoint passes on. Everything else is dropped, so a token holder cannot choose the model or
 * the provider, add paid plugins, raise the output limit or ask for several answers.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'response_format',
  'reasoning_effort',
  'verbosity',
  'stream',
]);

/** Four characters to a token: enough to charge an answer that never reports its usage. */
const CHARS_PER_TOKEN = 4;

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

/** The request as the provider gets it: known fields only, Synapse's model, capped output, and usage reported back. */
export function prepareBody(body: ChatBody, config: ExtensionConfig): ChatBody {
  const cap = (value: unknown): number =>
    typeof value === 'number' && value > 0
      ? Math.min(value, config.maxOutputTokens)
      : config.maxOutputTokens;
  const prepared: ChatBody = { model: config.model, usage: { include: true } };
  for (const [key, value] of Object.entries(body))
    if (ALLOWED_FIELDS.has(key)) prepared[key] = value;
  if ('max_completion_tokens' in body)
    prepared.max_completion_tokens = cap(body.max_completion_tokens);
  else prepared.max_tokens = cap(body.max_tokens);
  if (body.stream) prepared.stream_options = { include_usage: true };
  return prepared;
}

/** The fields the endpoint refused to pass on, for the log. */
export function droppedFields(body: ChatBody): string[] {
  // The endpoint sets these itself, so they are replaced rather than refused.
  const SERVER_SET = new Set(['model', 'max_tokens', 'max_completion_tokens', 'stream_options', 'usage']);
  return Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key) && !SERVER_SET.has(key));
}

/** What a request is likely to cost in input tokens, before the provider says. */
export function estimateInputTokens(body: ChatBody): number {
  const messages = body.messages;
  const text = messages === undefined ? '' : JSON.stringify(messages);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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

  /**
   * Charges the estimate before the call, so an answer the user abandons is still counted: the provider bills for the
   * prompt whether or not its usage report ever reaches us.
   */
  const open = async (req: ExtensionRequest, estimate: number): Promise<Types.ObjectId | null> => {
    if (!req.user) return null;
    return deps.store
      .recordBrowserExtensionUsage({
        user: req.user._id,
        tenantId: req.user.tenantId,
        llmModel: deps.config().model,
        inputTokens: estimate,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        at: now(),
      })
      .catch((error) => {
        logger.error('[browserExtension] usage not recorded', error);
        return null;
      });
  };

  /** Replaces the estimate with what the provider reported. Without a report the estimate stands. */
  const settle = async (id: Types.ObjectId | null, usage: ProviderUsage | null): Promise<void> => {
    if (!id || !usage) return;
    await deps.store
      .settleBrowserExtensionUsage(id, {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        costUsd: usage.cost ?? 0,
      })
      .catch((error) => logger.error('[browserExtension] usage not settled', error));
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
    const body = prepareBody((req.body ?? {}) as ChatBody, config);
    const refused = droppedFields((req.body ?? {}) as ChatBody);
    if (refused.length) logger.warn(`[browserExtension] fields not passed on: ${refused.join(', ')}`);
    const estimate = estimateInputTokens(body);
    const used = await deps.store.sumBrowserExtensionTokens(user._id, startOfUtcDay(now()));
    if (used + estimate >= config.dailyTokens) {
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
    const usageId = await open(req, estimate);
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
      logger.warn(`[browserExtension] provider answered ${upstream.status}: ${detail.slice(0, 500)}`);
      // The provider's own words can describe Synapse's account, so the user gets ours instead.
      res.status(upstream.status >= 500 ? 502 : 503).json({
        error: { code: 'model_unavailable', message: 'The model service refused this request. Try again later.' },
      });
      return;
    }
    if (!body.stream) {
      const payload = (await upstream.json()) as { usage?: ProviderUsage };
      await settle(usageId, payload.usage ?? null);
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
    await settle(usageId, usageFromStream(tail));
  };

  return { listModels, chatCompletions };
}
