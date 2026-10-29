import { buildModelLabelIndex, resolveModelLabel, bareModelId } from './labels';

import type { TModelSpec } from 'librechat-data-provider';

function spec(name: string, label: string, preset: TModelSpec['preset']): TModelSpec {
  return { name, label, preset } as TModelSpec;
}

const specs = [
  spec('office-assistant', 'Office Assistant', { agent_id: 'agent_office_assistant' }),
  spec('gpt-5.6-luna', 'ChatGPT', { endpoint: 'OpenRouter', model: 'openai/gpt-5.6-luna' }),
  spec('claude-haiku-4-5', 'Claude', { endpoint: 'Claude', model: 'claude-haiku-4-5' }),
  spec('z-ai-glm-5-2', 'GLM 5.2', { endpoint: 'NVIDIA', model: 'z-ai/glm-5.2' }),
] as TModelSpec[];

const agentModels = new Map([['agent_office_assistant', 'claude-haiku-4-5']]);

describe('buildModelLabelIndex', () => {
  it('indexes labels by spec name and by model id', () => {
    const index = buildModelLabelIndex({ modelSpecs: { list: specs } });

    expect(index.labelBySpecName.get('gpt-5.6-luna')).toBe('ChatGPT');
    expect(index.labelByModelId.get('openai/gpt-5.6-luna')).toBe('ChatGPT');
    expect(index.modelIds).toContain('z-ai/glm-5.2');
  });

  it('resolves an agent-backed spec through the agent model map', () => {
    const withoutAgents = buildModelLabelIndex({ modelSpecs: { list: [specs[0]] } });
    expect(withoutAgents.modelIds).toEqual([]);

    const withAgents = buildModelLabelIndex({ modelSpecs: { list: [specs[0]] }, agentModels });
    expect(withAgents.labelByModelId.get('claude-haiku-4-5')).toBe('Office Assistant');
  });

  it('keeps the first spec that claims a model id', () => {
    const index = buildModelLabelIndex({ modelSpecs: { list: specs }, agentModels });

    expect(index.labelByModelId.get('claude-haiku-4-5')).toBe('Office Assistant');
    expect(index.labelBySpecName.get('claude-haiku-4-5')).toBe('Claude');
  });

  it('tolerates missing, empty, and malformed spec lists', () => {
    expect(buildModelLabelIndex({}).modelIds).toEqual([]);
    expect(buildModelLabelIndex({ modelSpecs: null }).modelIds).toEqual([]);
    expect(buildModelLabelIndex({ modelSpecs: { list: [] } }).modelIds).toEqual([]);

    const partial = [{ name: 'no-label', preset: { model: 'x' } }] as TModelSpec[];
    expect(buildModelLabelIndex({ modelSpecs: { list: partial } }).modelIds).toEqual([]);
  });
});

describe('resolveModelLabel', () => {
  const index = buildModelLabelIndex({ modelSpecs: { list: specs }, agentModels });

  it('prefers the recorded spec over the model id', () => {
    expect(
      resolveModelLabel(index, { specName: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5' }),
    ).toBe('Claude');
  });

  it('falls back to the model id when the spec is unknown', () => {
    expect(resolveModelLabel(index, { specName: 'retired-spec', modelId: 'z-ai/glm-5.2' })).toBe(
      'GLM 5.2',
    );
  });

  it('matches model ids case-insensitively', () => {
    expect(resolveModelLabel(index, { modelId: 'OpenAI/GPT-5.6-Luna' })).toBe('ChatGPT');
  });

  it('returns undefined for a model outside the spec list', () => {
    expect(resolveModelLabel(index, { modelId: 'claude-sonnet-4-5' })).toBeUndefined();
    expect(resolveModelLabel(index, {})).toBeUndefined();
  });
});

describe('renamed and retired models', () => {
  const current = buildModelLabelIndex({
    modelSpecs: {
      list: [
        spec('gpt-6-luna', 'ChatGPT', { endpoint: 'OpenRouter', model: 'openai/gpt-6-luna' }),
        spec('anthropic/claude-haiku-5.5', 'Claude', {
          endpoint: 'OpenRouter',
          model: 'anthropic/claude-haiku-5.5',
        }),
      ] as TModelSpec[],
    },
  });

  it('strips the provider prefix from a model id', () => {
    expect(bareModelId('OpenAI/GPT-6-Luna ')).toBe('gpt-6-luna');
    expect(bareModelId('gpt-6-luna')).toBe('gpt-6-luna');
    expect(bareModelId(undefined)).toBe('');
  });

  it('matches a model id with or without its provider prefix', () => {
    expect(resolveModelLabel(current, { modelId: 'gpt-6-luna' })).toBe('ChatGPT');
    expect(resolveModelLabel(current, { modelId: 'openai/gpt-6-luna' })).toBe('ChatGPT');
  });

  it('names usage from a replaced spec or model after its successor', () => {
    expect(resolveModelLabel(current, { specName: 'gpt-5.6-luna' })).toBe('ChatGPT');
    expect(resolveModelLabel(current, { modelId: 'openai/gpt-5.6-luna' })).toBe('ChatGPT');
    expect(resolveModelLabel(current, { specName: 'claude-haiku-4-5' })).toBe('Claude');
    expect(resolveModelLabel(current, { modelId: 'anthropic/claude-haiku-4.5' })).toBe('Claude');
  });

  it('leaves a model with no successor unnamed, and ignores a successor that is gone', () => {
    expect(resolveModelLabel(current, { modelId: 'z-ai/glm-5.2' })).toBeUndefined();
    expect(
      resolveModelLabel(current, { modelId: 'google/gemini-3.1-flash-image' }),
    ).toBeUndefined();
  });
});
