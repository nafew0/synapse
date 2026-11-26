import { Types } from 'mongoose';
import { Tools, MemoryScope } from 'librechat-data-provider';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import {
  processMemory,
  createMemoryProcessor,
  linkMemoryAbort,
  createMemoryTool,
  getMemoryAgentId,
  getRequestMemories,
  createDeleteMemoryTool,
  invalidateRequestMemories,
  agentHasInlineMemoryTools,
  buildInlineMemoryContext,
  mergeMemoryValue,
  createMemoryLedger,
  compactMemories,
  parseCompactedMemories,
  takeFinishedMemory,
} from './memory';
import { GenerationJobManager } from '~/stream/GenerationJobManager';

jest.mock('~/stream/GenerationJobManager');

const mockCreateSafeUser = jest.fn((user) => ({
  id: user?.id,
  email: user?.email,
  name: user?.name,
  username: user?.username,
}));

const mockResolveHeaders = jest.fn((opts) => {
  const headers = opts.headers || {};
  const user = opts.user || {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let resolved = value as string;
    resolved = resolved.replace(/\$\{(\w+)\}/g, (_match, envVar) => process.env[envVar] || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_EMAIL\}\}/g, user.email || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_ID\}\}/g, user.id || '');
    result[key] = resolved;
  }
  return result;
});

type HeaderCarrier = { defaultHeaders?: Record<string, string> };
const mockResolveConfigHeaders = jest.fn(
  (opts: {
    llmConfig?: { configuration?: HeaderCarrier; clientOptions?: HeaderCarrier };
    user?: { id?: string; email?: string };
  }) => {
    const cfg = opts?.llmConfig;
    if (cfg?.configuration?.defaultHeaders != null) {
      cfg.configuration.defaultHeaders = mockResolveHeaders({
        headers: cfg.configuration.defaultHeaders,
        user: opts.user,
      });
    }
    if (cfg?.clientOptions?.defaultHeaders != null) {
      cfg.clientOptions.defaultHeaders = mockResolveHeaders({
        headers: cfg.clientOptions.defaultHeaders,
        user: opts.user,
      });
    }
  },
);

jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn(() => 10),
  },
  createSafeUser: (user: unknown) => mockCreateSafeUser(user),
  resolveConfigHeaders: (opts: unknown) => mockResolveConfigHeaders(opts as never),
}));

const { createSafeUser } = jest.requireMock('~/utils');

beforeEach(() => {
  jest.spyOn(Run, 'create').mockImplementation(
    () =>
      ({
        processStream: jest.fn(() => Promise.resolve('success')),
      }) as never,
  );
});

function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

describe('Memory attachment generation fencing', () => {
  it('emits artifacts with the generation epoch that started memory processing', async () => {
    const memoryArtifact = {
      type: 'update' as const,
      key: 'response_style',
      value: 'concise',
    };
    const processStream = jest.fn(async () => {
      const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
      runConfig.customHandlers[GraphEvents.TOOL_END].handle(
        GraphEvents.TOOL_END,
        {
          output: {
            tool_call_id: 'memory-call-1',
            artifact: { [Tools.memory]: memoryArtifact },
          },
        },
        {
          run_id: 'response-1',
          thread_id: 'conversation-1',
        },
      );
      return 'success';
    });
    (Run.create as jest.Mock).mockReturnValueOnce({ processStream });

    const [, runMemory] = await createMemoryProcessor({
      res: {
        headersSent: true,
        write: jest.fn(),
      } as unknown as Response,
      userId: 'user-1',
      messageId: 'response-1',
      conversationId: 'conversation-1',
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
      memoryMethods: {
        setMemory: jest.fn(),
        deleteMemory: jest.fn(),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
        }),
      },
    });

    await runMemory([]);

    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      {
        event: 'attachment',
        data: {
          type: Tools.memory,
          toolCallId: 'memory-call-1',
          messageId: 'response-1',
          conversationId: 'conversation-1',
          [Tools.memory]: memoryArtifact,
        },
      },
      { expectedCreatedAt: 1234 },
    );
  });
});

describe('linkMemoryAbort', () => {
  it('cancels extraction when the reply is stopped', () => {
    const reply = new AbortController();
    const { signal } = linkMemoryAbort(reply.signal);
    reply.abort();
    expect(signal.aborted).toBe(true);
  });

  it('keeps extraction running when the job aborts after the reply settled', () => {
    const reply = new AbortController();
    const { signal, detach } = linkMemoryAbort(reply.signal);
    detach();
    reply.abort();
    expect(signal.aborted).toBe(false);
  });

  it('starts cancelled when the reply is already stopped', () => {
    const reply = new AbortController();
    reply.abort();
    expect(linkMemoryAbort(reply.signal).signal.aborted).toBe(true);
  });
});

describe('Memory run usage and cancellation', () => {
  const createRunner = async () => {
    const [, runMemory] = await createMemoryProcessor({
      res: { headersSent: true, write: jest.fn() } as unknown as Response,
      userId: 'user-1',
      messageId: 'response-1',
      conversationId: 'conversation-1',
      config: { llmConfig: { provider: Providers.OPENROUTER, model: 'memory-model' } as never },
      memoryMethods: {
        setMemory: jest.fn(),
        deleteMemory: jest.fn(),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
        }),
      },
    });
    return runMemory;
  };

  it('collects the usage of each model call in the memory run', async () => {
    const processStream = jest.fn(async () => {
      const runConfig = (Run.create as jest.Mock).mock.lastCall[0];
      runConfig.customHandlers[GraphEvents.CHAT_MODEL_END].handle(GraphEvents.CHAT_MODEL_END, {
        output: { usage_metadata: { input_tokens: 40, output_tokens: 5 } },
      });
      return 'success';
    });
    (Run.create as jest.Mock).mockReturnValueOnce({ processStream });
    const collectedUsage: UsageMetadata[] = [];

    await (
      await createRunner()
    )([], { collectedUsage });

    expect(collectedUsage).toEqual([
      {
        input_tokens: 40,
        output_tokens: 5,
        model: 'memory-model',
        provider: Providers.OPENROUTER,
        runId: expect.any(String),
      },
    ]);
  });

  it('stops with the reply: passes the signal and resolves quietly on abort', async () => {
    const controller = new AbortController();
    const processStream = jest.fn(
      (_inputs: unknown, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          config.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    (Run.create as jest.Mock).mockReturnValueOnce({ processStream });
    const errorSpy = jest.spyOn(logger, 'error');

    const pending = (await createRunner())([], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).resolves.toBeUndefined();
    expect(processStream.mock.calls[0][1].signal).toBe(controller.signal);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('Memory Agent Header Resolution', () => {
  let testUser: IUser;
  let mockRes: Response;
  let mockMemoryMethods: {
    setMemory: jest.Mock;
    deleteMemory: jest.Mock;
    getFormattedMemories: jest.Mock;
  };

  beforeEach(() => {
    process.env.CUSTOM_API_KEY = 'sk-custom-test-key';
    process.env.TEST_CUSTOM_API_KEY = 'sk-custom-test-key';

    testUser = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });

    mockRes = {
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    } as unknown as Response;

    mockMemoryMethods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(() =>
        Promise.resolve({
          withKeys: 'formatted memories',
          withoutKeys: 'memories without keys',
          totalTokens: 100,
        }),
      ),
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUSTOM_API_KEY;
    delete process.env.TEST_CUSTOM_API_KEY;
  });

  it('should resolve environment variables in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'api-key': '${TEST_CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'api-key': 'sk-custom-test-key',
    });
  });

  it('should resolve user placeholders in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'X-User-Identifier': 'test@example.com',
      'X-User-ID': 'user-123',
    });
  });

  it('should handle mixed environment variables and user placeholders', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Application-Identifier': 'LibreChat - Test',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'X-User-Identifier': 'test@example.com',
      'X-Application-Identifier': 'LibreChat - Test',
    });
  });

  it('should resolve env vars when user is undefined', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: undefined,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
    });
  });

  it('should not throw when llmConfig has no configuration', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration).toBeUndefined();
  });

  it('should use createSafeUser to sanitize user data', async () => {
    const userWithSensitiveData = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      password: 'sensitive-password',
      refreshToken: 'sensitive-token',
    } as unknown as Partial<IUser>);

    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: userWithSensitiveData,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();

    // Verify createSafeUser was used - the user object passed to Run.create should not have sensitive fields
    const safeUser = createSafeUser(userWithSensitiveData);
    expect(safeUser).not.toHaveProperty('password');
    expect(safeUser).not.toHaveProperty('refreshToken');
    expect(safeUser).toHaveProperty('id');
    expect(safeUser).toHaveProperty('email');
  });

  it('should include instructions in user message for Bedrock provider', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    };

    const { HumanMessage } = await import('@librechat/agents/langchain/messages');
    const testMessage = new HumanMessage('test chat content');

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [testMessage],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For Bedrock, instructions should NOT be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBeUndefined();
    expect(runConfig.graphConfig.additional_instructions).toBeUndefined();
  });

  it('should pass instructions to graphConfig for non-Bedrock providers', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For non-Bedrock providers, instructions should be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBe('test instructions');
    expect(runConfig.graphConfig.additional_instructions).toBeDefined();
  });

  it('should set temperature to 1 for Bedrock with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      temperature: 0.7,
      additionalModelRequestFields: {
        thinking: {
          type: 'enabled',
          budget_tokens: 5000,
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(1);
  });

  it('should not modify temperature for Bedrock without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should remove temperature for Anthropic with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000,
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    });
  });

  it('should not modify temperature for Anthropic without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should not modify temperature for Anthropic with thinking type not enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'disabled',
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });
});

describe('createMemoryTool tokenLimit enforcement', () => {
  it('serializes parallel set_memory calls so they cannot collectively exceed tokenLimit', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; two of these (≈200) exceed the 150 limit, but each fits alone. */
    const value = 'word '.repeat(100).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 0,
    });

    await Promise.all([tool.invoke({ key: 'k1', value }), tool.invoke({ key: 'k2', value })]);

    /** Only the first write is committed; the second is rejected against the
     *  updated running total instead of the stale construction-time total. */
    expect(setMemory).toHaveBeenCalledTimes(1);
  });

  it('allows sequential writes that each fit within the remaining capacity', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const value = 'word '.repeat(10).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 1000,
      totalTokens: 0,
    });

    await tool.invoke({ key: 'k1', value });
    await tool.invoke({ key: 'k2', value });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('rejects values longer than charLimit without writing', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const tool = createMemoryTool({ userId: 'user-1', setMemory, charLimit: 10 });

    await tool.invoke({ key: 'k1', value: 'this value is far longer than ten characters' });

    expect(setMemory).not.toHaveBeenCalled();
  });

  it('treats a repeat write to the same key as a replacement, not an addition', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; two distinct keys would exceed the 150 limit, but rewriting
     *  the same key only replaces its value and must stay within the cap. */
    const value = 'word '.repeat(100).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 0,
    });

    await tool.invoke({ key: 'k1', value });
    await tool.invoke({ key: 'k1', value: `${value} again`, replace: true });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('does not write a fact that is already saved', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const tool = createMemoryTool({ userId: 'user-1', setMemory });

    await tool.invoke({ key: 'personal_info', value: "The user's name is Imtiaz." });
    await tool.invoke({ key: 'personal_info', value: "The user's name is Imtiaz" });

    expect(setMemory).toHaveBeenCalledTimes(1);
  });

  it('treats a persisted key as a replacement in a new tool instance', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; adding this value to its previous version would exceed the
     *  limit, while replacing it correctly remains within the limit. */
    const value = 'word '.repeat(100).trim();
    const firstTool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
    });

    await firstTool.invoke({ key: 'k1', value });

    const secondTool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 100,
      tokenCountsByKey: new Map([['k1', 100]]),
    });

    await secondTool.invoke({ key: 'k1', value, replace: true });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('fires onWrite after a successful set, but not when the write fails', async () => {
    const onWrite = jest.fn();
    const okTool = createMemoryTool({
      userId: 'user-1',
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      onWrite,
    });
    await okTool.invoke({ key: 'k1', value: 'a fact' });
    expect(onWrite).toHaveBeenCalledTimes(1);

    onWrite.mockClear();
    const failTool = createMemoryTool({
      userId: 'user-1',
      setMemory: jest.fn().mockResolvedValue({ ok: false }),
      onWrite,
    });
    await failTool.invoke({ key: 'k1', value: 'a fact' });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('fires onWrite after a successful delete', async () => {
    const onWrite = jest.fn();
    const tool = createDeleteMemoryTool({
      userId: 'user-1',
      deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
      onWrite,
    });

    await tool.invoke({ key: 'k1' });

    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});

describe('memory token limit guidance', () => {
  it('describes the aggregate limit and never reports negative remaining capacity', async () => {
    const [, process] = await createMemoryProcessor({
      res: { headersSent: false, write: jest.fn() } as unknown as Response,
      userId: 'user-1',
      messageId: 'message-1',
      conversationId: 'conversation-1',
      config: { tokenLimit: 100 },
      memoryMethods: {
        setMemory: jest.fn().mockResolvedValue({ ok: true }),
        deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: 'existing memory',
          withoutKeys: 'existing memory',
          totalTokens: 150,
          tokenCountsByKey: new Map([['preferences', 150]]),
        }),
      },
    });

    await process([]);

    const runCalls = (Run.create as jest.Mock).mock.calls;
    const runConfig = runCalls[runCalls.length - 1][0];
    expect(runConfig.graphConfig.instructions).toContain(
      'Maximum 100 tokens across all memory values.',
    );
    expect(runConfig.graphConfig.additional_instructions).toContain('Remaining capacity: 0 tokens');
  });
});

describe('agentHasInlineMemoryTools', () => {
  it('returns false for a nullish agent', () => {
    expect(agentHasInlineMemoryTools(null)).toBe(false);
    expect(agentHasInlineMemoryTools(undefined)).toBe(false);
  });

  it('honors an explicit memoryToolsRegistered flag over the raw marker', () => {
    /** Initialized config whose registration was denied (memoryAvailable false)
     *  but whose raw `memory` marker survived in tools must not be treated as
     *  memory-enabled. */
    expect(agentHasInlineMemoryTools({ memoryToolsRegistered: false, tools: ['memory'] })).toBe(
      false,
    );
    expect(agentHasInlineMemoryTools({ memoryToolsRegistered: true, tools: [] })).toBe(true);
  });

  it('falls back to the raw memory marker when no flag is present', () => {
    expect(agentHasInlineMemoryTools({ tools: ['memory'] })).toBe(true);
    expect(agentHasInlineMemoryTools({ tools: [{ name: 'memory' }] })).toBe(true);
    expect(agentHasInlineMemoryTools({ tools: ['execute_code'] })).toBe(false);
    expect(agentHasInlineMemoryTools({ tools: [] })).toBe(false);
  });
});

describe('buildInlineMemoryContext', () => {
  it('loads keyed memories for an initialized inline-memory agent', async () => {
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: 'preferred_name: Danny',
      withoutKeys: 'Danny',
      totalTokens: 4,
    });
    const context = await buildInlineMemoryContext({
      agent: {
        id: 'agent_memory',
        memory_scope: MemoryScope.agent,
        memoryToolsRegistered: true,
      },
      req: {} as never,
      userId: 'user-1',
      memoryAvailable: true,
      getFormattedMemories,
    });

    expect(context).toContain('# Existing memory about the user:\npreferred_name: Danny');
    expect(getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent_memory',
    });
  });

  it('does not load memories when inline tools are unavailable', async () => {
    const getFormattedMemories = jest.fn();
    await expect(
      buildInlineMemoryContext({
        agent: { id: 'agent_without_memory', memoryToolsRegistered: false },
        req: {} as never,
        userId: 'user-1',
        memoryAvailable: true,
        getFormattedMemories,
      }),
    ).resolves.toBe('');
    expect(getFormattedMemories).not.toHaveBeenCalled();
  });
});

describe('getRequestMemories caching', () => {
  it('memoizes per request, then re-fetches after invalidation', async () => {
    const getFormattedMemories = jest
      .fn()
      .mockResolvedValue({ withKeys: '', withoutKeys: '', totalTokens: 10 });
    const req = {};

    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    /** A second memory-enabled agent in the same run reuses the first fetch. */
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);

    /** A successful inline write invalidates the cache so a later tool round in
     *  the same response re-reads the post-write usage total. */
    invalidateRequestMemories(req);
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
  });

  it('caches and invalidates per partition', async () => {
    const getFormattedMemories = jest
      .fn()
      .mockResolvedValue({ withKeys: '', withoutKeys: '', totalTokens: 10 });
    const req = {};

    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    /** Personal pool and agent partition are distinct cache entries. */
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
    expect(getFormattedMemories).toHaveBeenLastCalledWith({
      userId: 'user-1',
      agentId: 'agent_a',
    });

    /** Invalidating one partition leaves the other cached. */
    invalidateRequestMemories(req, 'agent_a');
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(3);
  });
});

describe('getMemoryAgentId', () => {
  it('resolves the agent partition only for memory_scope "agent"', () => {
    expect(getMemoryAgentId({ id: 'agent_a', memory_scope: MemoryScope.agent })).toBe('agent_a');
    expect(getMemoryAgentId({ id: 'agent_a', memory_scope: MemoryScope.user })).toBeUndefined();
    expect(getMemoryAgentId({ id: 'agent_a' })).toBeUndefined();
    expect(getMemoryAgentId({ memory_scope: MemoryScope.agent })).toBeUndefined();
    expect(getMemoryAgentId(null)).toBeUndefined();
  });

  it('strips runtime id suffixes so added-conversation runs share the persisted partition', () => {
    expect(getMemoryAgentId({ id: 'agent_a____1', memory_scope: MemoryScope.agent })).toBe(
      'agent_a',
    );
  });
});

describe('mergeMemoryValue', () => {
  it('adds a new fact after what is saved', () => {
    expect(mergeMemoryValue("The user's name is Imtiaz.", 'The user is 30 years old.')).toBe(
      "The user's name is Imtiaz. The user is 30 years old.",
    );
  });

  it('adds a full stop between facts when the saved one has none', () => {
    expect(mergeMemoryValue('Name is Imtiaz', 'Born on 5 March 1995.')).toBe(
      'Name is Imtiaz. Born on 5 March 1995.',
    );
  });

  it('keeps the saved value when the fact is already there', () => {
    const saved = "The user's name is Imtiaz. The user is 30 years old.";
    expect(mergeMemoryValue(saved, 'the user is 30 years old')).toBe(saved);
  });

  it('takes a rewrite that already contains the saved value', () => {
    expect(
      mergeMemoryValue("The user's name is Imtiaz.", "The user's name is Imtiaz. Born in 1995."),
    ).toBe("The user's name is Imtiaz. Born in 1995.");
  });

  it('uses the new fact when nothing is saved', () => {
    expect(mergeMemoryValue(undefined, ' A fact. ')).toBe('A fact.');
  });
});

describe('createMemoryTool merging', () => {
  it('keeps the name when the age is saved under the same key', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      valuesByKey: new Map([['personal_info', "The user's name is Imtiaz."]]),
      tokenCountsByKey: new Map([['personal_info', 7]]),
      totalTokens: 7,
    });

    await tool.invoke({ key: 'personal_info', value: 'The user is 30 years old.' });
    await tool.invoke({ key: 'personal_info', value: 'The user was born on 5 March 1995.' });

    expect(setMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: 'personal_info',
        value:
          "The user's name is Imtiaz. The user is 30 years old. The user was born on 5 March 1995.",
      }),
    );
  });

  it('replaces the key when replace is set', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      valuesByKey: new Map([['work_info', 'The user is a lecturer at Rajshahi University.']]),
    });

    await tool.invoke({
      key: 'work_info',
      value: 'The user is a physics lecturer at Chittagong University.',
      replace: true,
    });

    expect(setMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'The user is a physics lecturer at Chittagong University.',
      }),
    );
  });

  it('compacts saved memories and retries when a write would pass the limit', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const ledger = createMemoryLedger({
      totalTokens: 140,
      tokenCountsByKey: new Map([['context', 140]]),
      valuesByKey: new Map([['context', 'word '.repeat(140).trim()]]),
    });
    const compact = jest.fn(async () => {
      ledger.totalTokens = 10;
      ledger.tokensByKey.set('context', 10);
      ledger.valuesByKey.set('context', 'A short summary.');
      return true;
    });
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      ledger,
      compact,
    });

    await tool.invoke({ key: 'personal_info', value: 'word '.repeat(30).trim() });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'personal_info' }));
  });

  it('frees a deleted key in the shared ledger', async () => {
    const ledger = createMemoryLedger({
      totalTokens: 100,
      tokenCountsByKey: new Map([['k1', 100]]),
      valuesByKey: new Map([['k1', 'old']]),
    });
    const deleteTool = createDeleteMemoryTool({
      userId: 'user-1',
      deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
      ledger,
    });

    await deleteTool.invoke({ key: 'k1' });

    expect(ledger.totalTokens).toBe(0);
    expect(ledger.valuesByKey.has('k1')).toBe(false);
  });
});

describe('parseCompactedMemories', () => {
  const current = new Map([
    ['personal_info', 'a'],
    ['work_info', 'b'],
  ]);

  it('reads a fenced JSON reply and keeps only known keys', () => {
    const text = '```json\n{"personal_info": "Name is Imtiaz.", "secret": "x"}\n```';
    expect(parseCompactedMemories(text, current)).toEqual(
      new Map([['personal_info', 'Name is Imtiaz.']]),
    );
  });

  it('returns undefined for a reply that is not JSON', () => {
    expect(parseCompactedMemories('NONE', current)).toBeUndefined();
  });
});

describe('compactMemories', () => {
  it('writes the shorter profile the model returns', async () => {
    jest.spyOn(Run, 'create').mockImplementation(
      () =>
        ({
          processStream: jest.fn(() =>
            Promise.resolve([
              { type: 'text', text: '{"personal_info": "Name is Imtiaz. Born 5 March 1995."}' },
            ]),
          ),
        }) as never,
    );
    const long = 'The user is called Imtiaz. '.repeat(20).trim();
    const ledger = createMemoryLedger({
      totalTokens: 120,
      tokenCountsByKey: new Map([['personal_info', 120]]),
      valuesByKey: new Map([['personal_info', long]]),
    });
    const setMemory = jest.fn().mockResolvedValue({ ok: true });

    const compacted = await compactMemories({
      ledger,
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      conversationId: 'conv-1',
      llmConfig: { provider: Providers.OPENAI, model: 'gemma-4' },
    });

    expect(compacted).toBe(true);
    expect(setMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'personal_info',
        value: 'Name is Imtiaz. Born 5 March 1995.',
      }),
    );
    expect(ledger.totalTokens).toBeLessThan(120);
  });

  it('keeps memories when the model returns nothing shorter', async () => {
    jest.spyOn(Run, 'create').mockImplementation(
      () =>
        ({
          processStream: jest.fn(() => Promise.resolve([{ type: 'text', text: 'NONE' }])),
        }) as never,
    );
    const ledger = createMemoryLedger({
      totalTokens: 5,
      tokenCountsByKey: new Map([['personal_info', 5]]),
      valuesByKey: new Map([['personal_info', 'Name is Imtiaz.']]),
    });
    const setMemory = jest.fn();

    const compacted = await compactMemories({
      ledger,
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      conversationId: 'conv-1',
      llmConfig: { provider: Providers.OPENAI, model: 'gemma-4' },
    });

    expect(compacted).toBe(false);
    expect(setMemory).not.toHaveBeenCalled();
  });
});

describe('takeFinishedMemory', () => {
  it('returns the result of extraction that already finished', async () => {
    const done = Promise.resolve(['attachment']);
    await done;
    await expect(takeFinishedMemory(done)).resolves.toEqual(['attachment']);
  });

  it('does not wait for extraction that is still running', async () => {
    let resolve: (value: string[]) => void = () => undefined;
    const running = new Promise<string[]>((r) => {
      resolve = r;
    });
    const started = Date.now();
    await expect(takeFinishedMemory(running)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(50);
    resolve([]);
  });

  it('returns undefined without a promise', async () => {
    await expect(takeFinishedMemory(null)).resolves.toBeUndefined();
  });
});
