import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { createTxMethods } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types';
import type { PricedEndpoint } from './rates';
import { matchModelName, findMatchingPattern } from '~/utils';
import { findUnpricedModels } from './rates';

const { getValueKey, getMultiplier, getCacheMultiplier } = createTxMethods(mongoose, {
  matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
});

type CustomEndpointConfig = {
  name: string;
  models?: { default?: string[] };
  tokenConfig?: EndpointTokenConfig;
};

function loadServedEndpoints(): PricedEndpoint[] {
  const file = path.resolve(__dirname, '../../../../librechat.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as {
    endpoints?: { custom?: CustomEndpointConfig[] };
  };
  return (config.endpoints?.custom ?? []).map((endpoint) => ({
    name: endpoint.name,
    models: endpoint.models?.default ?? [],
    tokenConfig: endpoint.tokenConfig,
  }));
}

describe('findUnpricedModels', () => {
  it('flags a dotted model id that only matches a family prefix', () => {
    const unpriced = findUnpricedModels(
      [{ name: 'OpenRouter', models: ['anthropic/claude-haiku-4.5'] }],
      getValueKey,
    );
    expect(unpriced).toEqual([
      { endpoint: 'OpenRouter', model: 'anthropic/claude-haiku-4.5', matchedKey: 'claude-' },
    ]);
  });

  it('accepts a model priced by its own key, with or without a date suffix', () => {
    expect(
      findUnpricedModels(
        [
          {
            name: 'OpenRouter',
            models: ['openai/gpt-5.6-luna', 'deepseek/deepseek-v4-flash-0731'],
          },
        ],
        getValueKey,
      ),
    ).toEqual([]);
  });

  it('accepts a model priced by the endpoint tokenConfig', () => {
    expect(
      findUnpricedModels(
        [
          {
            name: 'OpenRouter',
            models: ['anthropic/claude-haiku-4.5'],
            tokenConfig: {
              'anthropic/claude-haiku-4.5': { prompt: 1, completion: 5, context: 200000 },
            },
          },
        ],
        getValueKey,
      ),
    ).toEqual([]);
  });

  it('reports a model nothing matches', () => {
    const unpriced = findUnpricedModels(
      [{ name: 'OpenRouter', models: ['acme/unknown-model'] }],
      () => undefined,
    );
    expect(unpriced).toEqual([
      { endpoint: 'OpenRouter', model: 'acme/unknown-model', matchedKey: null },
    ]);
  });
});

describe('librechat.yaml pricing', () => {
  const endpoints = loadServedEndpoints();

  it('serves at least one custom endpoint', () => {
    expect(endpoints.length).toBeGreaterThan(0);
  });

  it('prices every served model at its own rate', () => {
    expect(findUnpricedModels(endpoints, getValueKey)).toEqual([]);
  });

  it('charges Claude Haiku 4.5 at its OpenRouter list price, cache included', () => {
    const openRouter = endpoints.find((endpoint) => endpoint.name === 'OpenRouter');
    const params = {
      model: 'anthropic/claude-haiku-4.5',
      endpoint: 'OpenRouter',
      endpointTokenConfig: openRouter?.tokenConfig as Record<string, Record<string, number>>,
    };
    expect(getMultiplier({ ...params, tokenType: 'prompt' })).toBe(1);
    expect(getMultiplier({ ...params, tokenType: 'completion' })).toBe(5);
    expect(getCacheMultiplier({ ...params, cacheType: 'read' })).toBe(0.1);
    expect(getCacheMultiplier({ ...params, cacheType: 'write' })).toBe(1.25);
  });

  it('gives every tokenConfig entry both an input and an output price', () => {
    const missing = endpoints.flatMap(({ name, tokenConfig }) =>
      Object.entries(tokenConfig ?? {})
        .filter(
          ([, rates]) => typeof rates.prompt !== 'number' || typeof rates.completion !== 'number',
        )
        .map(([model]) => `${name}: ${model}`),
    );
    expect(missing).toEqual([]);
  });
});
