/**
 * The `@` popover is a user-facing shortcut between the things the model picker offers.
 * With `modelSpecs.enforce` on, the curated spec list is the whole picker, so endpoints, the
 * raw provider/model tree, bare agents and presets must not be reachable through it — they are
 * the developer-facing layer underneath.
 */
import { renderHook } from '@testing-library/react';
import { RetentionMode } from 'librechat-data-provider';
import type { TModelSpec, TStartupConfig } from 'librechat-data-provider';

const mockStartupConfig: { current: Partial<TStartupConfig> } = { current: {} };

jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: { openAI: ['gpt-4o', 'gpt-4o-mini'] } }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig.current, isLoading: false }),
  /** The hook calls this twice: once raw for icons, once with `select: mapEndpoints`
   * for the endpoint list. Honor `select` so the real mapping runs. */
  useGetEndpointsQuery: (options?: { select?: (data: unknown) => unknown }) => {
    const data = { openAI: { type: 'openAI', order: 0 } };
    return { data: options?.select ? options.select(data) : data, isLoading: false };
  },
  useGetPresetsQuery: () => ({ data: [{ presetId: 'p1', title: 'My Preset' }], isLoading: false }),
  useListAgentsQuery: () => ({ data: null, isLoading: false }),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks/Assistants/useAssistantListMap', () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock('~/hooks/Roles/useHasAccess', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/components/Endpoints', () => ({
  EndpointIcon: () => null,
}));

import useMentions from '../useMentions';

const spec = (name: string, label: string): TModelSpec =>
  ({
    name,
    label,
    preset: { endpoint: 'openAI', model: 'gpt-4o' },
  }) as TModelSpec;

const startup = (enforce: boolean): Partial<TStartupConfig> => ({
  interface: { modelSelect: true, presets: true, retentionMode: RetentionMode.ALL },
  modelSpecs: {
    enforce,
    prioritize: true,
    list: [spec('office-assistant', 'Office Assistant'), spec('gpt-5.6-luna', 'ChatGPT')],
  },
});

const renderOptions = (enforce: boolean) => {
  mockStartupConfig.current = startup(enforce);
  const { result } = renderHook(() =>
    useMentions({ assistantMap: {}, includeAssistants: false }),
  );
  return result.current.options;
};

describe('useMentions with enforced model specs', () => {
  it('offers exactly the specs from the model picker', () => {
    const options = renderOptions(true);

    expect(options.map((option) => option.label)).toEqual(['Office Assistant', 'ChatGPT']);
    expect(options.every((option) => option.type === 'modelSpec')).toBe(true);
  });

  it('exposes no endpoint, raw model or preset entries', () => {
    const types = new Set(renderOptions(true).map((option) => option.type));

    expect(types.has('endpoint')).toBe(false);
    expect(types.has('model')).toBe(false);
    expect(types.has('preset')).toBe(false);
  });

  it('still offers the wider list when specs are not enforced', () => {
    const types = new Set(renderOptions(false).map((option) => option.type));

    expect(types.has('modelSpec')).toBe(true);
    expect(types.has('endpoint')).toBe(true);
  });
});
