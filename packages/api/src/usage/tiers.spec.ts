import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { createTxMethods } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types';
import { matchModelName, findMatchingPattern } from '~/utils';
import fixture from './fixtures/openrouter-pricing.json';
import { computeUsageCostUSD } from '~/agents/usage';
import { creditRates } from './credits';

const {
  getValueKey,
  getMultiplier,
  getCacheMultiplier,
  premiumTokenValues,
  premiumCacheTokenValues,
} = createTxMethods(mongoose, {
  matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
});
const pricing = { getMultiplier, getCacheMultiplier };

interface OpenRouterRates {
  prompt: string;
  completion: string;
  input_cache_read: string;
  input_cache_write: string;
}
interface OpenRouterPricing extends OpenRouterRates {
  overrides?: Array<OpenRouterRates & { min_prompt_tokens: number }>;
}

const models = fixture.models as Record<string, { pricing: OpenRouterPricing }>;

function servedTokenConfig(): EndpointTokenConfig {
  const file = path.resolve(__dirname, '../../../../librechat.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as {
    endpoints: { custom: Array<{ name: string; tokenConfig?: EndpointTokenConfig }> };
  };
  const endpoint = config.endpoints.custom.find((entry) => entry.name === 'OpenRouter');
  return endpoint?.tokenConfig ?? {};
}

/** OpenRouter's own rule: the highest tier whose `min_prompt_tokens` the whole prompt reaches. */
function openRouterCost(
  id: string,
  usage: { prompt: number; read: number; write: number; completion: number },
): number {
  const { pricing: block } = models[id];
  const tier = (block.overrides ?? [])
    .filter((override) => usage.prompt >= override.min_prompt_tokens)
    .pop();
  const rates = tier ?? block;
  const fresh = usage.prompt - usage.read - usage.write;
  return (
    fresh * Number(rates.prompt) +
    usage.read * Number(rates.input_cache_read) +
    usage.write * Number(rates.input_cache_write) +
    usage.completion * Number(rates.completion)
  );
}

function synapseCost(id: string, usage: Parameters<typeof openRouterCost>[1]): number {
  return computeUsageCostUSD(
    {
      input_tokens: usage.prompt,
      output_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
      model: id,
      provider: 'openAI',
      input_token_details: { cache_read: usage.read, cache_creation: usage.write },
    },
    pricing,
    servedTokenConfig(),
  );
}

/** Standard (below-threshold) rates as Synapse resolves them for a served model, in USD per 1M tokens. */
function baseRates(id: string): {
  prompt: number;
  completion: number;
  read: number;
  write: number;
} {
  const params = { model: id, endpoint: 'OpenRouter', endpointTokenConfig: servedTokenConfig() };
  return {
    prompt: getMultiplier({ ...params, tokenType: 'prompt' }),
    completion: getMultiplier({ ...params, tokenType: 'completion' }),
    read: getCacheMultiplier({ ...params, cacheType: 'read' }) as number,
    write: getCacheMultiplier({ ...params, cacheType: 'write' }) as number,
  };
}

const tiered = Object.entries(models).filter(([, { pricing: block }]) => block.overrides?.length);

describe('long-prompt tiers match OpenRouter', () => {
  it.each(tiered.map(([id]) => id))('%s has a tier for every OpenRouter override', (id) => {
    const key = getValueKey(id, 'OpenRouter') as string;
    const overrides = models[id].pricing.overrides ?? [];
    expect(overrides).toHaveLength(1);
    const [override] = overrides;
    expect(premiumTokenValues[key]).toBeDefined();
    expect(premiumCacheTokenValues[key]).toBeDefined();
    expect(premiumTokenValues[key].threshold).toBe(override.min_prompt_tokens);
    expect(premiumCacheTokenValues[key].threshold).toBe(override.min_prompt_tokens);
    expect(premiumTokenValues[key].prompt).toBeCloseTo(Number(override.prompt) * 1e6);
    expect(premiumTokenValues[key].completion).toBeCloseTo(Number(override.completion) * 1e6);
    expect(premiumCacheTokenValues[key].read).toBeCloseTo(Number(override.input_cache_read) * 1e6);
    expect(premiumCacheTokenValues[key].write).toBeCloseTo(
      Number(override.input_cache_write) * 1e6,
    );
  });

  it.each(tiered.map(([id]) => id))('%s base rates match OpenRouter', (id) => {
    const base = models[id].pricing;
    const rates = baseRates(id);
    expect(rates.prompt).toBeCloseTo(Number(base.prompt) * 1e6);
    expect(rates.completion).toBeCloseTo(Number(base.completion) * 1e6);
    expect(rates.read).toBeCloseTo(Number(base.input_cache_read) * 1e6);
    expect(rates.write).toBeCloseTo(Number(base.input_cache_write) * 1e6);
  });

  describe.each(
    tiered.map(([id, { pricing: block }]) => [id, block.overrides?.[0].min_prompt_tokens]),
  )('%s', (id, threshold) => {
    const cases = [
      ['just below the threshold', (threshold as number) - 1000],
      ['just above the threshold', (threshold as number) + 1000],
    ] as const;
    it.each(cases)('prices a call %s without cache', (_label, prompt) => {
      const usage = { prompt, read: 0, write: 0, completion: 2000 };
      expect(synapseCost(id as string, usage)).toBeCloseTo(openRouterCost(id as string, usage), 9);
    });
    it.each(cases)('prices a call %s with cache reads and writes', (_label, prompt) => {
      const usage = { prompt, read: Math.floor(prompt * 0.7), write: 3000, completion: 2000 };
      expect(synapseCost(id as string, usage)).toBeCloseTo(openRouterCost(id as string, usage), 9);
    });
    it('counts cached tokens toward the threshold', () => {
      /** 60% of a prompt below the threshold is cached; the whole prompt is above it. */
      const prompt = (threshold as number) + 1000;
      const usage = { prompt, read: Math.floor(prompt * 0.9), write: 0, completion: 500 };
      const flatRates = baseRates(id as string);
      const flat =
        ((prompt - usage.read) * flatRates.prompt +
          usage.read * flatRates.read +
          500 * flatRates.completion) /
        1e6;
      expect(synapseCost(id as string, usage)).toBeGreaterThan(flat * 1.5);
      expect(synapseCost(id as string, usage)).toBeCloseTo(openRouterCost(id as string, usage), 9);
    });
    it('reserves credits at the tier rate for a prompt above the threshold', () => {
      const base = baseRates(id as string);
      const params = {
        model: id as string,
        endpoint: 'OpenRouter',
        endpointTokenConfig: servedTokenConfig(),
        pricing,
      };
      expect(creditRates({ ...params, inputTokenCount: (threshold as number) - 1 })).toEqual({
        input: base.prompt,
        output: base.completion,
      });
      const above = creditRates({ ...params, inputTokenCount: (threshold as number) + 1 });
      expect(above.input).toBeGreaterThan(base.prompt);
      expect(above.output).toBeGreaterThan(base.completion);
      expect(above.input).toBeCloseTo(
        Number((models[id as string].pricing.overrides ?? [])[0].prompt) * 1e6,
      );
    });
  });
});

describe('endpoint tokenConfig and the premium tables', () => {
  it('keeps a configured price below the threshold and scales it above', () => {
    const config = { 'acme/custom': { prompt: 1, completion: 2 } };
    const params = { model: 'anthropic/claude-haiku-5.5', endpoint: 'OpenRouter' };
    const custom = { 'anthropic/claude-haiku-5.5': { prompt: 0.2, completion: 1, read: 0.02 } };
    expect(getMultiplier({ ...params, tokenType: 'prompt', endpointTokenConfig: custom })).toBe(
      0.2,
    );
    expect(
      getMultiplier({
        ...params,
        tokenType: 'prompt',
        endpointTokenConfig: custom,
        inputTokenCount: 150000,
      }),
    ).toBeCloseTo(1);
    expect(
      getCacheMultiplier({
        cacheType: 'read',
        ...params,
        endpointTokenConfig: custom,
        inputTokenCount: 150000,
      }),
    ).toBeCloseTo(0.1);
    expect(
      getMultiplier({
        model: 'acme/custom',
        tokenType: 'prompt',
        endpointTokenConfig: config,
        inputTokenCount: 900000,
      }),
    ).toBe(1);
  });

  it('keeps a missing cache rate missing', () => {
    expect(
      getCacheMultiplier({
        cacheType: 'write',
        model: 'anthropic/claude-haiku-5.5',
        endpointTokenConfig: { 'anthropic/claude-haiku-5.5': { prompt: 0.1, completion: 0.5 } },
        inputTokenCount: 150000,
      }),
    ).toBeNull();
  });

  it('prices both models from the built-in table when no endpoint config exists', () => {
    expect(getMultiplier({ model: 'anthropic/claude-haiku-5.5', tokenType: 'prompt' })).toBe(0.1);
    expect(
      getMultiplier({
        model: 'anthropic/claude-haiku-5.5',
        tokenType: 'prompt',
        inputTokenCount: 100001,
      }),
    ).toBe(0.5);
    expect(
      getMultiplier({
        model: 'openai/gpt-6-luna',
        tokenType: 'completion',
        inputTokenCount: 272001,
      }),
    ).toBe(0.75);
    expect(
      getCacheMultiplier({
        model: 'openai/gpt-6-luna',
        cacheType: 'write',
        inputTokenCount: 272001,
      }),
    ).toBe(0.25);
  });
});
