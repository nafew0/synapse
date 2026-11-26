import type { CatalogServer } from './catalog.helper';
import { fetchAllCatalogs, fetchCatalog, parsePricing, perMillion } from './openrouter';
import { startCatalogServer } from './catalog.helper';

describe('perMillion', () => {
  it('converts USD per token to USD per 1M tokens without float noise', () => {
    expect(perMillion('0.0000001')).toBe(0.1);
    expect(perMillion('0.000000825')).toBe(0.825);
    expect(perMillion('0.0000000416666666666667')).toBe(0.04166666667);
    expect(perMillion(0.000003)).toBe(3);
  });

  it('keeps zero and rejects missing, empty, negative and non-numeric values', () => {
    expect(perMillion('0')).toBe(0);
    expect(perMillion(undefined)).toBeUndefined();
    expect(perMillion('')).toBeUndefined();
    expect(perMillion('-1')).toBeUndefined();
    expect(perMillion('abc')).toBeUndefined();
  });
});

describe('parsePricing', () => {
  it('returns undefined without a usable prompt price', () => {
    expect(parsePricing(undefined)).toBeUndefined();
    expect(parsePricing({ completion: '0.000001' })).toBeUndefined();
    expect(parsePricing({ prompt: '-1' })).toBeUndefined();
  });

  it('parses cache, extra rates and context length', () => {
    const price = parsePricing(
      {
        prompt: '0.000000825',
        completion: '0.000004125',
        input_cache_read: '0.0000000825',
        input_cache_write: '0.000000125',
        input_cache_write_1h: '0.0000002',
        internal_reasoning: '0.000004125',
        image: '0.000000825',
        image_output: '0.00006',
        web_search: '0.014',
      },
      1048576,
    );
    expect(price).toEqual({
      prompt: 0.825,
      completion: 4.125,
      cacheRead: 0.0825,
      cacheWrite: 0.125,
      cacheWrite1h: 0.2,
      reasoning: 4.125,
      image: 0.825,
      imageOutput: 60,
      webSearch: 0.014,
      contextLength: 1048576,
      tiers: [],
    });
  });

  it('defaults a missing completion to 0 and omits undefined fields', () => {
    const price = parsePricing({ prompt: '0.0000002' });
    expect(price).toEqual({ prompt: 0.2, completion: 0, tiers: [] });
    expect(Object.keys(price ?? {})).not.toContain('cacheRead');
  });

  it('parses tiers sorted by threshold and drops unusable ones', () => {
    const price = parsePricing({
      prompt: '0.0000001',
      completion: '0.0000005',
      overrides: [
        {
          min_prompt_tokens: 200000,
          prompt: '0.000001',
          completion: '0.000004',
        },
        {
          min_prompt_tokens: '100000',
          prompt: '0.0000005',
          completion: '0.0000025',
          input_cache_read: '0.00000005',
          input_cache_write: '0.000000625',
          input_cache_write_1h: '0.000001',
        },
        { min_prompt_tokens: 0, prompt: '0.1', completion: '0.1' },
        { min_prompt_tokens: 300000, prompt: '0.1' },
      ],
    });
    expect(price?.tiers).toEqual([
      {
        minPromptTokens: 100000,
        prompt: 0.5,
        completion: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
        cacheWrite1h: 1,
      },
      { minPromptTokens: 200000, prompt: 1, completion: 4 },
    ]);
  });
});

describe('catalog fetching against a local server', () => {
  let server: CatalogServer;

  beforeAll(async () => {
    server = await startCatalogServer();
  });
  afterAll(() => server.close());
  beforeEach(() => {
    server.mode = 'ok';
    server.hits.length = 0;
  });

  it('parses the chat catalog with tiers and cache prices from the fixture', async () => {
    const models = await fetchCatalog('models', { baseUrl: server.baseUrl });
    const haiku = models.find((m) => m.modelId === 'anthropic/claude-haiku-5.5');
    expect(haiku?.kind).toBe('chat');
    expect(haiku?.price).toMatchObject({
      prompt: 0.1,
      completion: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      cacheWrite1h: 0.2,
      webSearch: 0.01,
      contextLength: 1000000,
    });
    expect(haiku?.price.tiers).toEqual([
      {
        minPromptTokens: 100000,
        prompt: 0.5,
        completion: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
        cacheWrite1h: 1,
      },
    ]);
    const luna = models.find((m) => m.modelId === 'openai/gpt-6-luna');
    expect(luna?.price.tiers[0]).toMatchObject({ minPromptTokens: 272000, prompt: 0.2 });
    expect(server.hits).toEqual(['/models']);
  });

  it('keeps canonical_slug as an alias only when it differs from the id', async () => {
    const models = await fetchCatalog('models', { baseUrl: server.baseUrl });
    expect(models.find((m) => m.modelId === 'anthropic/claude-haiku-5.5')?.aliases).toEqual([
      'anthropic/claude-haiku-5.5-20261007',
    ]);
    const embeddings = await fetchCatalog('embeddings/models', { baseUrl: server.baseUrl });
    expect(embeddings.find((m) => m.modelId === 'google/gemini-embedding-2')?.aliases).toEqual([]);
  });

  it('marks the embeddings catalog as embedding models', async () => {
    const embeddings = await fetchCatalog('embeddings/models', { baseUrl: server.baseUrl });
    expect(embeddings.map((m) => m.kind)).toEqual(['embedding', 'embedding']);
    expect(embeddings[0].price).toMatchObject({ prompt: 0.2, completion: 0, image: 0.45 });
    expect(server.hits).toEqual(['/embeddings/models']);
  });

  it('merges both catalogs by lowercase id and alias', async () => {
    const all = await fetchAllCatalogs({ baseUrl: server.baseUrl });
    expect(all.get('anthropic/claude-haiku-5.5')?.price.prompt).toBe(0.1);
    expect(all.get('anthropic/claude-haiku-5.5-20261007')?.modelId).toBe(
      'anthropic/claude-haiku-5.5',
    );
    expect(all.get('google/gemini-embedding-2')?.kind).toBe('embedding');
  });

  it('skips listings without an id or a prompt price', async () => {
    server.chat = {
      data: [
        { id: 'a/free-less' },
        { pricing: { prompt: '0.1' } },
        { id: 'a/ok', pricing: { prompt: '0.000001' } },
      ],
    };
    const models = await fetchCatalog('models', { baseUrl: server.baseUrl });
    expect(models.map((m) => m.modelId)).toEqual(['a/ok']);
  });

  it('throws on a body that is not a model list', async () => {
    server.mode = 'garbage';
    await expect(fetchCatalog('models', { baseUrl: server.baseUrl })).rejects.toThrow(
      /no model list/,
    );
    await expect(fetchAllCatalogs({ baseUrl: server.baseUrl })).rejects.toThrow(/no model list/);
  });

  it('throws on a non-2xx answer', async () => {
    server.mode = 'error';
    await expect(fetchCatalog('models', { baseUrl: server.baseUrl })).rejects.toThrow(
      /answered 500/,
    );
  });

  it('throws when the server does not answer in time', async () => {
    server.mode = 'hang';
    await expect(
      fetchCatalog('models', { baseUrl: server.baseUrl, timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it('throws when nothing is listening', async () => {
    await expect(
      fetchCatalog('models', { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }),
    ).rejects.toThrow();
  });
});
