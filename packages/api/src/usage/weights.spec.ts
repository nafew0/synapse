import {
  DEFAULT_USAGE_WEIGHT,
  isImageModel,
  splitImageUsage,
  toBillingTokens,
  unitFor,
  weightFor,
} from './weights';

describe('unitFor', () => {
  it('meters image endpoints in images', () => {
    expect(unitFor('OpenRouter Image')).toBe('images');
    expect(unitFor('BdREN AI Image')).toBe('images');
  });

  it('meters every other endpoint in tokens', () => {
    for (const endpoint of ['agents', 'Claude', 'OpenAI', 'OpenRouter', 'NVIDIA', 'anthropic']) {
      expect(unitFor(endpoint)).toBe('tokens');
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(unitFor('  openrouter image  ')).toBe('images');
  });

  it('defaults to tokens for a missing endpoint', () => {
    expect(unitFor(undefined)).toBe('tokens');
    expect(unitFor(null)).toBe('tokens');
  });
});

describe('weightFor', () => {
  it('doubles Claude reached directly', () => {
    expect(weightFor('Claude')).toBe(2);
    expect(weightFor('claude')).toBe(2);
  });

  /** The whole point of the weight: the Office Assistant must stay the cheapest
   *  path even though its master turn runs on the same Claude model. */
  it('does not weight the agents endpoint', () => {
    expect(weightFor('agents')).toBe(DEFAULT_USAGE_WEIGHT);
  });

  it('does not weight the built-in anthropic endpoint used by the agent master', () => {
    expect(weightFor('anthropic')).toBe(DEFAULT_USAGE_WEIGHT);
  });

  it('leaves other endpoints at 1', () => {
    for (const endpoint of ['OpenAI', 'OpenRouter', 'NVIDIA', 'OpenRouter Image']) {
      expect(weightFor(endpoint)).toBe(DEFAULT_USAGE_WEIGHT);
    }
  });
});

describe('toBillingTokens', () => {
  it('applies the weight', () => {
    expect(toBillingTokens(1000, 2)).toBe(2000);
    expect(toBillingTokens(1000, 1)).toBe(1000);
  });

  it('rounds up so a weight never loses usage', () => {
    expect(toBillingTokens(3, 1.5)).toBe(5);
  });

  it('clamps negatives to zero', () => {
    expect(toBillingTokens(-100, 2)).toBe(0);
    expect(toBillingTokens(100, -2)).toBe(0);
  });
});

describe('isImageModel', () => {
  it('recognises the image models this deployment has used', () => {
    for (const model of [
      'x-ai/grok-imagine-image-2.0',
      'x-ai/grok-imagine-image-quality',
      'google/gemini-3.1-flash-image',
      'qwen/qwen-image-3',
      'openai/gpt-5.4-image-2',
      'bytedance-seed/seedream-4.5',
    ]) {
      expect(isImageModel(model)).toBe(true);
    }
  });

  it('does not mistake text models for image models', () => {
    for (const model of [
      'claude-haiku-4-5',
      'openai/gpt-5.6-luna',
      'z-ai/glm-5.2',
      'gpt-4o',
      '',
      null,
      undefined,
    ]) {
      expect(isImageModel(model)).toBe(false);
    }
  });
});

describe('splitImageUsage', () => {
  /** The case Phase 4 exists for: one agent run, master + document specialist +
   *  a delegated image. The image must not be metered as ~4,175 text tokens. */
  it('separates a delegated image from the run that produced it', () => {
    const { tokenUsages, images } = splitImageUsage([
      { model: 'claude-haiku-4-5', output_tokens: 134 },
      { model: 'openai/gpt-5.6-luna', output_tokens: 2052 },
      { model: 'x-ai/grok-imagine-image-2.0', output_tokens: 4175 },
    ]);
    expect(images).toBe(1);
    expect(tokenUsages.map((usage) => usage.model)).toEqual([
      'claude-haiku-4-5',
      'openai/gpt-5.6-luna',
    ]);
  });

  it('counts each generation in a run that produced several', () => {
    const { images } = splitImageUsage([
      { model: 'x-ai/grok-imagine-image-2.0', output_tokens: 4175 },
      { model: 'x-ai/grok-imagine-image-2.0', output_tokens: 4175 },
    ]);
    expect(images).toBe(2);
  });

  /** A refused or failed generation produces no output and is not billed by the
   *  provider, so it must not consume the user's allowance either. */
  it('does not charge for a generation that produced nothing', () => {
    const { images, tokenUsages } = splitImageUsage([
      { model: 'x-ai/grok-imagine-image-2.0', output_tokens: 0 },
    ]);
    expect(images).toBe(0);
    expect(tokenUsages).toHaveLength(0);
  });

  it('leaves a run with no images untouched', () => {
    const usages = [{ model: 'openai/gpt-5.6-luna', output_tokens: 100 }];
    const { tokenUsages, images } = splitImageUsage(usages);
    expect(images).toBe(0);
    expect(tokenUsages).toEqual(usages);
  });

  it('tolerates empty and null input', () => {
    expect(splitImageUsage(undefined)).toEqual({ tokenUsages: [], images: 0 });
    expect(splitImageUsage([null, undefined])).toEqual({ tokenUsages: [], images: 0 });
  });
});
