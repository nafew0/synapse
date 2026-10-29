import { Tools, FileSources } from 'librechat-data-provider';
import type { TConversation, TEphemeralAgent, TModelSpec } from 'librechat-data-provider';
import type { LoadAgentDeps } from './load';
import { scopeEphemeralAgent } from './toggles';
import { loadEphemeralAgent } from './load';
import { loadAddedAgent } from './added';

const deps: LoadAgentDeps = {
  getAgent: async () => null,
  getMCPServerTools: async () => null,
};

const chatSpec = {
  name: 'chat-spec',
  label: 'Chat',
  fileSearch: true,
  hideBadgeRow: true,
  preset: { endpoint: 'OpenRouter', model: 'some/model' },
} as unknown as TModelSpec;

const toggleSpec = {
  name: 'toggle-spec',
  label: 'Toggles',
  preset: { endpoint: 'OpenRouter', model: 'some/model' },
} as unknown as TModelSpec;

const sandboxSpec = {
  name: 'sandbox-spec',
  label: 'Sandbox',
  executeCode: true,
  hideBadgeRow: true,
  preset: { endpoint: 'OpenRouter', model: 'some/model' },
} as unknown as TModelSpec;

const config = {
  config: {},
  fileStrategy: FileSources.local,
  imageOutputType: 'png',
  modelSpecs: { list: [chatSpec, toggleSpec, sandboxSpec] },
};

const everything: TEphemeralAgent = {
  mcp: ['server'],
  web_search: true,
  file_search: true,
  execute_code: true,
  memory: true,
  ask_user_question: true,
  artifacts: 'default',
};

async function ephemeralTools(spec: string | undefined, ephemeralAgent: TEphemeralAgent) {
  const agent = await loadEphemeralAgent(
    {
      req: { user: { id: 'user-1' }, config, body: { ephemeralAgent } } as never,
      spec,
      endpoint: 'OpenRouter',
      model_parameters: { model: 'some/model' } as never,
    },
    deps,
  );
  return agent?.tools ?? [];
}

describe('scopeEphemeralAgent', () => {
  test('keeps every switch when no spec is selected', () => {
    expect(scopeEphemeralAgent(everything, null)).toEqual(everything);
  });

  test('drops only execute_code for a spec that shows the badge row', () => {
    const scoped = scopeEphemeralAgent(everything, toggleSpec);
    expect(scoped?.execute_code).toBeUndefined();
    expect(scoped?.web_search).toBe(true);
    expect(scoped?.mcp).toEqual(['server']);
  });

  test('drops every tool switch for a spec that hides the badge row', () => {
    expect(scopeEphemeralAgent(everything, chatSpec)).toEqual({ artifacts: 'default' });
  });

  test('does not mutate the request body', () => {
    const body = { ...everything };
    scopeEphemeralAgent(body, chatSpec);
    expect(body).toEqual(everything);
  });
});

describe('loadEphemeralAgent tool switches', () => {
  test('a chat spec never gets the sandbox from a hand-edited request', async () => {
    const tools = await ephemeralTools('chat-spec', { execute_code: true });
    expect(tools).not.toContain(Tools.execute_code);
    expect(tools).toContain(Tools.file_search);
  });

  test('a chat spec ignores every request switch, keeping only its own tools', async () => {
    expect(await ephemeralTools('chat-spec', everything)).toEqual([Tools.file_search]);
  });

  test('a spec with executeCode still gets the sandbox', async () => {
    expect(await ephemeralTools('sandbox-spec', {})).toContain(Tools.execute_code);
  });

  test('a spec with the badge row keeps user toggles but not the sandbox', async () => {
    const tools = await ephemeralTools('toggle-spec', { execute_code: true, web_search: true });
    expect(tools).toEqual([Tools.web_search]);
  });

  test('without a spec the request switches stand', async () => {
    expect(await ephemeralTools(undefined, { execute_code: true })).toContain(Tools.execute_code);
  });
});

describe('loadAddedAgent tool switches', () => {
  test('an added chat-spec agent never gets the sandbox from the request', async () => {
    const agent = await loadAddedAgent(
      {
        req: { user: { id: 'user-1' }, config } as never,
        conversation: {
          endpoint: 'OpenRouter',
          model: 'some/model',
          spec: 'chat-spec',
          ephemeralAgent: { execute_code: true, web_search: true },
        } as unknown as TConversation,
      },
      deps,
    );
    expect(agent?.tools).toEqual([Tools.file_search]);
  });
});
