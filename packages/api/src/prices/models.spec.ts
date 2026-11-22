import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { PriceConfigSource, ModelUses } from './models';
import { addUsedModels, collectConfiguredModels, UNLISTED_OK } from './models';

const REAL_YAML = path.resolve(__dirname, '../../../../librechat.yaml');

describe('collectConfiguredModels', () => {
  it('reads models, title models, specs, memory and summarization with where each is used', () => {
    const uses = collectConfiguredModels({
      endpoints: {
        custom: [
          {
            name: 'OpenRouter',
            titleModel: 'google/gemini-3.8-flash',
            models: { default: ['anthropic/claude-haiku-5.5', ' openai/gpt-6-luna '] },
          },
        ],
      },
      modelSpecs: {
        list: [
          { name: 'fast', preset: { model: 'anthropic/claude-haiku-5.5' } },
          { preset: { model: 'a/b' } },
        ],
      },
      memory: { agent: { model: 'deepseek/deepseek-v4-flash-0731' } },
      summarization: { model: 'google/gemini-3.8-flash' },
    });
    expect([...(uses.get('anthropic/claude-haiku-5.5') ?? [])].sort()).toEqual([
      'endpoint:OpenRouter',
      'spec:fast',
    ]);
    expect([...(uses.get('openai/gpt-6-luna') ?? [])]).toEqual(['endpoint:OpenRouter']);
    expect([...(uses.get('google/gemini-3.8-flash') ?? [])].sort()).toEqual([
      'summarization',
      'title',
    ]);
    expect([...(uses.get('deepseek/deepseek-v4-flash-0731') ?? [])]).toEqual(['memory']);
    expect([...(uses.get('a/b') ?? [])]).toEqual(['spec:unnamed']);
  });

  it('tolerates empty and partial config and ignores blank ids', () => {
    expect(collectConfiguredModels(undefined).size).toBe(0);
    expect(collectConfiguredModels(null).size).toBe(0);
    const uses = collectConfiguredModels({
      endpoints: { custom: [{ models: { default: ['', '  '] } }, {}] },
    });
    expect(uses.size).toBe(0);
  });

  it('collects from the real librechat.yaml shape', () => {
    const config = yaml.load(fs.readFileSync(REAL_YAML, 'utf8')) as PriceConfigSource;
    const uses: ModelUses = collectConfiguredModels(config);
    const custom = config.endpoints?.custom ?? [];
    expect(custom.length).toBeGreaterThan(0);
    const expected = new Set<string>();
    custom.forEach((endpoint) => {
      (endpoint.models?.default ?? []).forEach((m) => expected.add(m.trim()));
      if (endpoint.titleModel) {
        expected.add(endpoint.titleModel.trim());
      }
    });
    (config.modelSpecs?.list ?? []).forEach(
      (s) => s.preset?.model && expected.add(s.preset.model.trim()),
    );
    if (config.memory?.agent?.model) {
      expected.add(config.memory.agent.model.trim());
    }
    if (config.summarization?.model) {
      expected.add(config.summarization.model.trim());
    }
    expect(uses.size).toBe(expected.size);
    expect(uses.size).toBeGreaterThan(0);
    expected.forEach((id) => expect(uses.has(id)).toBe(true));
    uses.forEach((set) => expect(set.size).toBeGreaterThan(0));
  });
});

describe('addUsedModels', () => {
  it('adds only slash ids, merging uses of an existing model', () => {
    const uses: ModelUses = new Map([['a/b', new Set(['endpoint:x'])]]);
    addUsedModels(uses, ['a/b', 'gpt-4', null, undefined, '', 'c/d'], 'agent');
    expect([...(uses.get('a/b') ?? [])].sort()).toEqual(['agent', 'endpoint:x']);
    expect([...(uses.get('c/d') ?? [])]).toEqual(['agent']);
    expect(uses.has('gpt-4')).toBe(false);
    expect(uses.size).toBe(2);
  });
});

describe('UNLISTED_OK', () => {
  it('names the image model priced outside OpenRouter', () => {
    expect(Object.keys(UNLISTED_OK)).toContain('x-ai/grok-imagine-image-2.0');
  });
});
