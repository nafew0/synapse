import { randomUUID } from 'crypto';
/** Memories */
import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import {
  Tools,
  MemoryScope,
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  AgentCapabilities,
  stripAgentIdSuffix,
} from 'librechat-data-provider';
import type {
  MessageContentComplex,
  OpenAIClientOptions,
  StreamEventData,
  ToolEndCallback,
  LCToolRegistry,
  EventHandler,
  ToolEndData,
  LLMConfig,
  LCTool,
} from '@librechat/agents';
import type {
  IRole,
  ObjectId,
  MemoryMethods,
  IUser,
  FormattedMemoriesResult,
} from '@librechat/data-schemas';
import type { BaseMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { TAttachment, MemoryArtifact } from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { ServerRequest, RunLLMConfig } from '~/types';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { resolveConfigHeaders, createSafeUser, writeGuarded } from '~/utils';
import { checkAccess } from '~/middleware/access';
import { isMemoryEnabled } from '~/memory';
import Tokenizer from '~/utils/tokenizer';

type RequiredMemoryMethods = Pick<
  MemoryMethods,
  'setMemory' | 'deleteMemory' | 'getFormattedMemories'
>;

type ToolEndMetadata = Record<string, unknown> & {
  run_id?: string;
  thread_id?: string;
};

type SanitizedMemoryLLMConfig = Omit<Partial<LLMConfig>, 'apiKey'> & { apiKey?: string };

export interface MemoryConfig {
  validKeys?: string[];
  instructions?: string;
  llmConfig?: Partial<LLMConfig>;
  tokenLimit?: number;
}

function normalizeMemoryLLMConfig(llmConfig?: Partial<LLMConfig>): SanitizedMemoryLLMConfig {
  const config = { ...(llmConfig ?? {}) } as Record<string, unknown>;
  if (typeof config.apiKey !== 'string') {
    delete config.apiKey;
  }
  return config as SanitizedMemoryLLMConfig;
}

export interface MemoryRunOptions {
  /** Cancels extraction when the user stops the reply */
  signal?: AbortSignal;
  /** Receives the token usage of each model call in the memory run */
  collectedUsage?: UsageMetadata[];
}

/**
 * Links memory extraction to the reply's abort signal for as long as the reply
 * runs. `completeJob` also aborts that signal on successful completion, so call
 * `detach` once the reply settles or slow extractions get cancelled.
 */
export function linkMemoryAbort(replySignal: AbortSignal): {
  signal: AbortSignal;
  detach: () => void;
} {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (replySignal.aborted) {
    stop();
  } else {
    replySignal.addEventListener('abort', stop, { once: true });
  }
  return {
    signal: controller.signal,
    detach: () => replySignal.removeEventListener('abort', stop),
  };
}

const MEMORY_PENDING = Symbol('memory-pending');

/**
 * Returns memory extraction's attachments only if extraction has already
 * finished. The reply never waits for it: unfinished extraction keeps running
 * in the background and saves its memories when it is done.
 */
export async function takeFinishedMemory<T>(
  memoryPromise?: Promise<T> | null,
): Promise<T | undefined> {
  if (!memoryPromise) {
    return undefined;
  }
  try {
    const result = await Promise.race([memoryPromise, Promise.resolve(MEMORY_PENDING)]);
    if (result === MEMORY_PENDING) {
      logger.debug('[MemoryAgent] Reply finished first; memory continues in the background');
      return undefined;
    }
    return result as T;
  } catch (error) {
    logger.error('[MemoryAgent] Memory extraction failed', error);
    return undefined;
  }
}

export const memoryInstructions =
  'The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management.';

/**
 * Tells the chat model that a background agent saves memories by itself, so it
 * neither asks the user whether to remember something nor claims it cannot.
 */
export const autoMemoryInstructions =
  'Synapse remembers lasting facts about the user by itself: a background process reads every message and saves them, and the user can see or edit them in Settings. Never ask whether to remember or save something, never offer to, and never say you cannot remember earlier chats. Use the saved facts when they help.';

export const SET_MEMORY_TOOL_NAME = 'set_memory';
export const DELETE_MEMORY_TOOL_NAME = 'delete_memory';

/** Maximum memory key length, matching the REST memory routes. */
const MEMORY_KEY_CHAR_LIMIT = 1000;

const SET_MEMORY_DESCRIPTION =
  'Saves a fact about the user. The fact is added to what is already saved under the key; nothing saved there is lost.';
const SET_MEMORY_VALUE_DESCRIPTION =
  'One complete sentence with the new fact. With replace, the full new value for the key.';
const SET_MEMORY_REPLACE_DESCRIPTION =
  'Only when a saved fact under this key is no longer true (a new job, a corrected name). The value then replaces the whole key, so include everything still true.';
const DELETE_MEMORY_DESCRIPTION =
  'Deletes specific memory data about the user using the provided key. For updating existing memories, use the `set_memory` tool instead';

const getDefaultInstructions = (
  validKeys?: string[],
  tokenLimit?: number,
) => `Use the \`set_memory\` tool to save important information about the user, but ONLY when the user has requested you to remember something.

The \`delete_memory\` tool should only be used in two scenarios:
  1. When the user explicitly asks to forget or remove specific information
  2. When updating existing memories, use the \`set_memory\` tool instead of deleting and re-adding the memory.

1. ONLY use memory tools when the user requests memory actions with phrases like:
   - "Remember [that] [I]..."
   - "Don't forget [that] [I]..."
   - "Please remember..."
   - "Store this..."
   - "Forget [that] [I]..."
   - "Delete the memory about..."

2. NEVER store information just because the user mentioned it in conversation.

3. NEVER use memory tools when the user asks you to use other tools or invoke tools in general.

4. Memory tools are ONLY for memory requests, not for general tool usage.

5. If the user doesn't ask you to remember or forget something, DO NOT use any memory tools.

${validKeys && validKeys.length > 0 ? `\nVALID KEYS: ${validKeys.join(', ')}` : ''}

${tokenLimit ? `\nTOKEN LIMIT: Maximum ${tokenLimit} tokens across all memory values.` : ''}

When in doubt, and the user hasn't asked to remember or forget anything, END THE TURN IMMEDIATELY.`;

type MemoryArtifactRecord = Record<Tools.memory, MemoryArtifact>;

/**
 * Running view of a user's saved memories, shared by the set and delete tools
 * and compaction so every write measures limits against current values.
 */
export interface MemoryLedger {
  totalTokens: number;
  tokensByKey: Map<string, number>;
  valuesByKey: Map<string, string>;
}

export function createMemoryLedger({
  totalTokens = 0,
  tokenCountsByKey,
  valuesByKey,
}: {
  totalTokens?: number;
  tokenCountsByKey?: ReadonlyMap<string, number>;
  valuesByKey?: ReadonlyMap<string, string>;
}): MemoryLedger {
  return {
    totalTokens,
    tokensByKey: new Map(tokenCountsByKey),
    valuesByKey: new Map(valuesByKey),
  };
}

const normalizeFact = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\s.,;:!?\u0964"'()]+/g, ' ')
    .trim();

/**
 * Adds a new fact to a key's saved value instead of replacing it. A fact
 * already present is not repeated, and a value that already contains the saved
 * one (the model rewrote the whole key) is taken as is.
 */
export function mergeMemoryValue(existing: string | undefined, incoming: string): string {
  const base = (existing ?? '').trim();
  const addition = incoming.trim();
  if (!base) {
    return addition;
  }
  if (!addition) {
    return base;
  }
  const normalizedBase = normalizeFact(base);
  const normalizedAddition = normalizeFact(addition);
  if (normalizedBase.includes(normalizedAddition)) {
    return base;
  }
  if (normalizedAddition.includes(normalizedBase)) {
    return addition;
  }
  const separator = /[.!?\u0964]$/.test(base) ? ' ' : '. ';
  return `${base}${separator}${addition}`;
}

const countMemoryTokens = (value: string): number => Tokenizer.getTokenCount(value, 'o200k_base');

const limitErrorArtifact = (
  errorType: 'already_exceeded' | 'would_exceed',
  overBy: number,
  totalTokens: number,
  tokenLimit: number,
  baseTotalTokens: number,
): MemoryArtifactRecord => ({
  [Tools.memory]: {
    key: 'system',
    type: 'error',
    value: JSON.stringify({ errorType, tokenCount: Math.abs(overBy), totalTokens, tokenLimit }),
    tokenCount: baseTotalTokens,
  },
});

/**
 * Creates a memory tool instance with user context. A write adds the fact to
 * what the key already holds; `replace` overwrites the key. When a write would
 * pass `tokenLimit`, `compact` (if given) shortens the saved memories first.
 */
export const createMemoryTool = ({
  userId,
  agentId,
  setMemory,
  validKeys,
  charLimit,
  tokenLimit,
  totalTokens = 0,
  tokenCountsByKey,
  valuesByKey,
  ledger: sharedLedger,
  compact,
  onWrite,
}: {
  userId: string | ObjectId;
  /** Agent partition to write to; omit for the shared personal pool */
  agentId?: string;
  setMemory: MemoryMethods['setMemory'];
  validKeys?: string[];
  charLimit?: number;
  tokenLimit?: number;
  totalTokens?: number;
  tokenCountsByKey?: ReadonlyMap<string, number>;
  valuesByKey?: ReadonlyMap<string, string>;
  /** Shared with the delete tool and compaction; built from the seeds above when omitted */
  ledger?: MemoryLedger;
  compact?: () => Promise<boolean>;
  onWrite?: () => void;
}): DynamicStructuredTool => {
  const ledger = sharedLedger ?? createMemoryLedger({ totalTokens, tokenCountsByKey, valuesByKey });
  /** Writes are serialized so parallel `set_memory` calls in one batch can't
   *  each pass the limit check against the same stale total. */
  let writeChain: Promise<unknown> = Promise.resolve();

  const write = async (
    key: string,
    value: string,
    replace: boolean,
    canCompact: boolean,
  ): Promise<[string, MemoryArtifactRecord?]> => {
    const existing = ledger.valuesByKey.get(key);
    const nextValue = replace ? value.trim() : mergeMemoryValue(existing, value);
    if (existing != null && nextValue === existing.trim()) {
      return [`Already saved under "${key}"`, undefined];
    }
    if (charLimit && nextValue.length > charLimit) {
      if (canCompact && compact && (await compact())) {
        return write(key, value, replace, false);
      }
      return [`Value exceeds maximum length of ${charLimit} characters.`, undefined];
    }

    const tokenCount = countMemoryTokens(nextValue);
    /** Total excluding this key's current value: a write replaces it. */
    const baseTotalTokens = ledger.totalTokens - (ledger.tokensByKey.get(key) ?? 0);
    const newTotalTokens = baseTotalTokens + tokenCount;
    if (tokenLimit && newTotalTokens > tokenLimit) {
      if (canCompact && compact && (await compact())) {
        return write(key, value, replace, false);
      }
      const alreadyOver = tokenLimit - baseTotalTokens <= 0;
      return alreadyOver
        ? [
            'Memory storage exceeded. Cannot save new memories.',
            limitErrorArtifact(
              'already_exceeded',
              tokenLimit - baseTotalTokens,
              baseTotalTokens,
              tokenLimit,
              baseTotalTokens,
            ),
          ]
        : [
            'Memory storage would exceed limit. Cannot save this memory.',
            limitErrorArtifact(
              'would_exceed',
              tokenLimit - newTotalTokens,
              newTotalTokens,
              tokenLimit,
              baseTotalTokens,
            ),
          ];
    }

    const result = await setMemory({ userId, key, value: nextValue, tokenCount, agentId });
    if (!result.ok) {
      logger.warn(`Failed to set memory for key "${key}" for user "${userId}"`);
      return [`Failed to set memory for key "${key}"`, undefined];
    }
    ledger.totalTokens = newTotalTokens;
    ledger.tokensByKey.set(key, tokenCount);
    ledger.valuesByKey.set(key, nextValue);
    onWrite?.();
    logger.debug(`Memory set for key "${key}" (${tokenCount} tokens) for user "${userId}"`);
    const artifact: MemoryArtifactRecord = {
      [Tools.memory]: {
        key,
        value: nextValue,
        tokenCount,
        type: 'update',
        ...(agentId ? { agentId } : {}),
      },
    };
    return [`Memory set for key "${key}" (${tokenCount} tokens)`, artifact];
  };

  return tool(
    async ({ key, value, replace }) => {
      const run = async (): Promise<[string, MemoryArtifactRecord?]> => {
        try {
          if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
            logger.warn(
              `Memory Agent failed to set memory: Invalid key "${key}". Must be one of: ${validKeys.join(
                ', ',
              )}`,
            );
            return [`Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`, undefined];
          }
          /** Mirror the REST memory routes' size guards so inline writes can't
           *  persist values the normal memory UI/API would reject. */
          if (key.length > MEMORY_KEY_CHAR_LIMIT) {
            return [
              `Key exceeds maximum length of ${MEMORY_KEY_CHAR_LIMIT} characters.`,
              undefined,
            ];
          }
          return await write(key, value, replace === true, true);
        } catch (error) {
          logger.error('Memory Agent failed to set memory', error);
          return [`Error setting memory for key "${key}"`, undefined];
        }
      };

      const resultPromise = writeChain.then(run, run);
      /** Keep the chain alive (and non-rejecting) so the next queued call still
       *  runs even if a prior one threw; `run` already resolves on every path. */
      writeChain = resultPromise.catch(() => undefined);
      return resultPromise;
    },
    {
      name: SET_MEMORY_TOOL_NAME,
      description: SET_MEMORY_DESCRIPTION,
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory value. Must be one of: ${validKeys.join(', ')}`
              : 'The key identifier for this memory',
          ),
        value: z.string().describe(SET_MEMORY_VALUE_DESCRIPTION),
        replace: z.boolean().optional().describe(SET_MEMORY_REPLACE_DESCRIPTION),
      }),
    },
  );
};

/**
 * Creates a delete memory tool instance with user context
 */
export const createDeleteMemoryTool = ({
  userId,
  agentId,
  deleteMemory,
  validKeys,
  ledger,
  onWrite,
}: {
  userId: string | ObjectId;
  /** Agent partition to delete from; omit for the shared personal pool */
  agentId?: string;
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  /** Shared with the set tool, so a delete frees its tokens for later writes */
  ledger?: MemoryLedger;
  onWrite?: () => void;
}): DynamicStructuredTool => {
  return tool(
    async ({ key }) => {
      try {
        if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
          logger.warn(
            `Memory Agent failed to delete memory: Invalid key "${key}". Must be one of: ${validKeys.join(
              ', ',
            )}`,
          );
          return [`Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`, undefined];
        }

        const artifact: Record<Tools.memory, MemoryArtifact> = {
          [Tools.memory]: {
            key,
            type: 'delete',
            ...(agentId ? { agentId } : {}),
          },
        };

        const result = await deleteMemory({ userId, key, agentId });
        if (result.ok) {
          if (ledger) {
            ledger.totalTokens -= ledger.tokensByKey.get(key) ?? 0;
            ledger.tokensByKey.delete(key);
            ledger.valuesByKey.delete(key);
          }
          onWrite?.();
          logger.debug(`Memory deleted for key "${key}" for user "${userId}"`);
          return [`Memory deleted for key "${key}"`, artifact];
        }
        logger.warn(`Failed to delete memory for key "${key}" for user "${userId}"`);
        return [`Failed to delete memory for key "${key}"`, undefined];
      } catch (error) {
        logger.error('Memory Agent failed to delete memory', error);
        return [`Error deleting memory for key "${key}"`, undefined];
      }
    },
    {
      name: DELETE_MEMORY_TOOL_NAME,
      description: DELETE_MEMORY_DESCRIPTION,
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory to delete. Must be one of: ${validKeys.join(', ')}`
              : 'The key identifier of the memory to delete',
          ),
      }),
    },
  );
};
/**
 * Strict usage guard appended to the agent's instructions when the inline
 * memory tools are registered, preserving the memory-agent's explicit-request
 * behavior so the model never stores facts it merely observed.
 */
export const memoryToolUsageGuard = `Only use the \`set_memory\` and \`delete_memory\` tools when the user explicitly asks you to remember, update, or forget something (e.g. "remember that...", "don't forget...", "forget..."). Never store information merely because the user mentioned it in conversation.`;

/**
 * LLM-facing definitions for the inline memory tool pair, used by the
 * event-driven (definitions-only) loader. The `memory` capability string on
 * an agent's `tools` array expands into this pair at initialize time via
 * {@link registerMemoryTools}; the runtime instances created in the tool
 * service enforce `validKeys`/`tokenLimit` and emit memory artifacts.
 * `validKeys` is surfaced in the key descriptions so the model is told the
 * allowed keys up front, matching the runtime `createMemoryTool` schema.
 */
export function getMemoryToolDefinitions(validKeys?: string[]): LCTool[] {
  const hasValidKeys = Array.isArray(validKeys) && validKeys.length > 0;
  return [
    {
      name: SET_MEMORY_TOOL_NAME,
      description: SET_MEMORY_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: hasValidKeys
              ? `The key of the memory value. Must be one of: ${validKeys!.join(', ')}`
              : 'The key identifier for this memory',
          },
          value: {
            type: 'string',
            description: SET_MEMORY_VALUE_DESCRIPTION,
          },
          replace: {
            type: 'boolean',
            description: SET_MEMORY_REPLACE_DESCRIPTION,
          },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: DELETE_MEMORY_TOOL_NAME,
      description: DELETE_MEMORY_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: hasValidKeys
              ? `The key of the memory to delete. Must be one of: ${validKeys!.join(', ')}`
              : 'The key identifier of the memory to delete',
          },
        },
        required: ['key'],
      },
    },
  ] as LCTool[];
}

/**
 * Idempotently registers the inline memory tool pair (`set_memory` +
 * `delete_memory`) into the run's tool registry and tool-definition list.
 * Mirrors `registerCodeExecutionTools`: the `memory` capability string stays
 * as the `agent.tools` trigger marker and expands into this pair here so the
 * definitions-only loader surfaces both tools to the LLM.
 */
export function registerMemoryTools({
  toolRegistry,
  toolDefinitions,
  validKeys,
}: {
  toolRegistry?: LCToolRegistry;
  toolDefinitions?: LCTool[];
  validKeys?: string[];
}): { toolDefinitions: LCTool[]; registered: string[]; toolNames: string[] } {
  const memoryToolDefinitions = getMemoryToolDefinitions(validKeys);
  const toolNames = memoryToolDefinitions.map((def) => def.name);
  const inputDefinitions = toolDefinitions ?? [];
  const newDefs: LCTool[] = [];
  const registered: string[] = [];

  for (const def of memoryToolDefinitions) {
    const inRegistry = toolRegistry?.has(def.name) === true;
    const inDefs = inputDefinitions.some((d) => d.name === def.name);
    if (inRegistry || inDefs) {
      continue;
    }
    toolRegistry?.set(def.name, def);
    newDefs.push(def);
    registered.push(def.name);
  }

  if (newDefs.length === 0) {
    return { toolDefinitions: inputDefinitions, registered, toolNames };
  }
  return { toolDefinitions: [...inputDefinitions, ...newDefs], registered, toolNames };
}

type GetRoleByName = (
  roleName: string,
  fieldsToSelect?: string | string[],
) => Promise<IRole | null>;

type InlineMemoryAgent =
  | { id?: string; tools?: unknown[]; memoryToolsRegistered?: boolean; memory_scope?: MemoryScope }
  | null
  | undefined;

/**
 * Resolves the memory partition an agent reads/writes: its persisted id when
 * the agent opted into isolated memory (`memory_scope: 'agent'`), otherwise
 * `undefined` for the shared personal pool. Runtime ids carry a `____N`
 * suffix in added-conversation paths, so the suffix is stripped to keep the
 * partition stable across single- and multi-agent runs. Ephemeral agents
 * never carry `memory_scope`, so they always resolve to the shared pool.
 */
export function getMemoryAgentId(agent: InlineMemoryAgent): string | undefined {
  if (agent?.memory_scope === MemoryScope.agent && typeof agent.id === 'string' && agent.id) {
    return stripAgentIdSuffix(agent.id);
  }
  return undefined;
}

/**
 * Whether an agent carries the inline memory tools. Prefers the LibreChat-only
 * `memoryToolsRegistered` flag set by `initializeAgent`, falling back to the raw
 * `memory` capability marker on `tools`. This works for both the raw agent and
 * the initialized config that may be held in the tool-execution context, and
 * never matches an MCP tool that merely shares the `set_memory`/`delete_memory`
 * name (that name only collides at the tool level, not the capability marker).
 */
export function agentHasInlineMemoryTools(agent: InlineMemoryAgent): boolean {
  if (!agent) {
    return false;
  }
  /** An initialized config carries an explicit boolean: honor it so an agent
   *  whose registration was denied (`false`) is not treated as memory-enabled
   *  just because the raw `memory` marker survives in `tools`. Fall back to the
   *  marker only for the raw agent, where the flag is absent. */
  if (typeof agent.memoryToolsRegistered === 'boolean') {
    return agent.memoryToolsRegistered;
  }
  return (agent.tools ?? []).some(
    (entry) =>
      (typeof entry === 'string' ? entry : (entry as { name?: string })?.name) === Tools.memory,
  );
}

/** Builds the existing-memory system context for an inline-memory agent. */
export async function buildInlineMemoryContext({
  agent,
  req,
  userId,
  memoryAvailable,
  getFormattedMemories,
}: {
  agent: InlineMemoryAgent;
  req: ServerRequest;
  userId: string | ObjectId;
  memoryAvailable: boolean;
  getFormattedMemories: MemoryMethods['getFormattedMemories'];
}): Promise<string> {
  if (!memoryAvailable || !agentHasInlineMemoryTools(agent)) {
    return '';
  }
  try {
    const memories = await getRequestMemories({
      req,
      userId,
      agentId: getMemoryAgentId(agent),
      getFormattedMemories,
    });
    return memories.withKeys
      ? `${memoryInstructions}\n\n# Existing memory about the user:\n${memories.withKeys}`
      : '';
  } catch (error) {
    logger.error('[memory] Error loading inline agent memory context', error);
    return '';
  }
}

/**
 * Request-scoped cache so that multiple memory-enabled agents in one run (and
 * the run's memory context load) share a single `getFormattedMemories` call
 * per partition instead of each re-fetching the same memories.
 */
const requestMemoriesCache = new WeakMap<object, Map<string, Promise<FormattedMemoriesResult>>>();

export function getRequestMemories({
  req,
  userId,
  agentId,
  getFormattedMemories,
}: {
  req: object;
  userId: string | ObjectId;
  /** Agent partition; omit for the shared personal pool */
  agentId?: string;
  getFormattedMemories: MemoryMethods['getFormattedMemories'];
}): Promise<FormattedMemoriesResult> {
  let partitions = requestMemoriesCache.get(req);
  if (!partitions) {
    partitions = new Map();
    requestMemoriesCache.set(req, partitions);
  }
  const partitionKey = agentId ?? '';
  let cached = partitions.get(partitionKey);
  if (!cached) {
    cached = getFormattedMemories({ userId, agentId });
    partitions.set(partitionKey, cached);
  }
  return cached;
}

/**
 * Drops the cached memories for a request partition so the next
 * {@link getRequestMemories} re-fetches. Inline `set_memory`/`delete_memory`
 * writes call this on success so a later tool round in the same response is
 * seeded with the post-write usage total instead of a stale pre-write one.
 */
export function invalidateRequestMemories(req: object, agentId?: string): void {
  requestMemoriesCache.get(req)?.delete(agentId ?? '');
}

/**
 * Re-checks the run-level memory gate at tool-execution time: the agents
 * `memory` capability is enabled, memory is configured, the user hasn't opted
 * out, and the user holds the required (write) permissions. The event-driven
 * executor loads tools by requested name, so this must be re-verified rather
 * than trusted from registration time.
 */
export async function isMemoryToolAllowed({
  req,
  writePermissions = [],
  getRoleByName,
}: {
  req: ServerRequest;
  writePermissions?: Permissions[];
  getRoleByName: GetRoleByName;
}): Promise<boolean> {
  const agentsCapabilities = req?.config?.endpoints?.[EModelEndpoint.agents]?.capabilities;
  if (
    !Array.isArray(agentsCapabilities) ||
    !agentsCapabilities.includes(AgentCapabilities.memory)
  ) {
    return false;
  }
  if (!isMemoryEnabled(req?.config?.memory)) {
    return false;
  }
  if (!req?.user || req.user.personalization?.memories === false) {
    return false;
  }
  try {
    return await checkAccess({
      user: req.user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE, ...writePermissions],
      getRoleByName,
    });
  } catch (error) {
    logger.error('[memory] Memory permission check failed', error);
    return false;
  }
}

/**
 * Builds an inline memory tool instance for the event-driven executor, applying
 * the full opt-in + permission + config gate. Returns `null` when the call is
 * not permitted (e.g. a hallucinated/undeclared call, missing write permission,
 * or a disabled capability), so the executor drops the tool.
 */
export async function buildInlineMemoryTool({
  toolName,
  req,
  agent,
  userId,
  memoryMethods,
  getRoleByName,
}: {
  toolName: string;
  req: ServerRequest;
  agent: InlineMemoryAgent;
  userId: string | ObjectId;
  memoryMethods: Pick<MemoryMethods, 'setMemory' | 'deleteMemory' | 'getFormattedMemories'>;
  getRoleByName: GetRoleByName;
}): Promise<DynamicStructuredTool | null> {
  if (!agentHasInlineMemoryTools(agent)) {
    return null;
  }

  const memoryConfig = req?.config?.memory;
  const validKeys = memoryConfig?.validKeys as string[] | undefined;
  const memoryAgentId = getMemoryAgentId(agent);

  if (toolName === DELETE_MEMORY_TOOL_NAME) {
    const allowed = await isMemoryToolAllowed({
      req,
      writePermissions: [Permissions.UPDATE],
      getRoleByName,
    });
    if (!allowed) {
      return null;
    }
    return createDeleteMemoryTool({
      userId,
      agentId: memoryAgentId,
      deleteMemory: memoryMethods.deleteMemory,
      validKeys,
      onWrite: () => invalidateRequestMemories(req, memoryAgentId),
    });
  }

  const allowed = await isMemoryToolAllowed({
    req,
    writePermissions: [Permissions.CREATE, Permissions.UPDATE],
    getRoleByName,
  });
  if (!allowed) {
    return null;
  }

  const charLimit = memoryConfig?.charLimit as number | undefined;
  const tokenLimit = memoryConfig?.tokenLimit as number | undefined;
  let totalTokens = 0;
  let tokenCountsByKey: ReadonlyMap<string, number> | undefined;
  let valuesByKey: ReadonlyMap<string, string> | undefined;
  try {
    const formatted = await getRequestMemories({
      req,
      userId,
      agentId: memoryAgentId,
      getFormattedMemories: memoryMethods.getFormattedMemories,
    });
    totalTokens = formatted?.totalTokens ?? 0;
    tokenCountsByKey = formatted?.tokenCountsByKey;
    valuesByKey = formatted?.valuesByKey;
  } catch (error) {
    logger.error('[memory] Failed to load saved memories for set_memory', error);
    /** Fail closed: without the current usage total a configured tokenLimit
     *  could be silently bypassed. */
    if (tokenLimit) {
      return null;
    }
  }

  return createMemoryTool({
    userId,
    agentId: memoryAgentId,
    setMemory: memoryMethods.setMemory,
    validKeys,
    charLimit,
    tokenLimit,
    totalTokens,
    tokenCountsByKey,
    valuesByKey,
    onWrite: () => invalidateRequestMemories(req, memoryAgentId),
  });
}

/** Collects token usage from the memory run so the caller can record it. */
const createMemoryUsageHandler = (
  collectedUsage: UsageMetadata[],
  runId: string,
  llmConfig?: Partial<LLMConfig>,
): EventHandler => ({
  handle: (_event, data, metadata) => {
    const usage = (data as { output?: { usage_metadata?: UsageMetadata } } | undefined)?.output
      ?.usage_metadata;
    if (!usage) {
      return;
    }
    const model = metadata?.ls_model_name ?? (llmConfig as { model?: string } | undefined)?.model;
    collectedUsage.push({
      ...usage,
      runId,
      ...(typeof model === 'string' ? { model } : {}),
      ...(llmConfig?.provider ? { provider: llmConfig.provider } : {}),
    });
  },
});

export class BasicToolEndHandler implements EventHandler {
  private callback?: ToolEndCallback;
  constructor(callback?: ToolEndCallback) {
    this.callback = callback;
  }

  handle(
    event: string,
    data: StreamEventData | undefined,
    metadata?: Record<string, unknown>,
  ): void {
    if (!metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }
    const toolEndData = data as ToolEndData | undefined;
    if (!toolEndData?.output) {
      console.warn('No output found in tool_end event');
      return;
    }
    this.callback?.(toolEndData, metadata);
  }
}

/** Model settings for memory runs: never streamed, no retries, provider quirks applied. */
function buildMemoryLLMConfig({
  llmConfig,
  user,
  conversationId,
  messageId,
}: {
  llmConfig?: Partial<LLMConfig>;
  user?: IUser;
  conversationId: string;
  messageId: string;
}): LLMConfig {
  const defaultLLMConfig: LLMConfig = {
    provider: Providers.OPENAI,
    model: 'gpt-4.1-mini',
    temperature: 0.4,
    streaming: false,
    disableStreaming: true,
  };

  const finalLLMConfig = {
    ...defaultLLMConfig,
    ...normalizeMemoryLLMConfig(llmConfig),
    maxRetries: 0,
    /**
     * Ensure streaming is always disabled for memory processing
     */
    streaming: false,
    disableStreaming: true,
  } as LLMConfig;

  // Handle GPT-5+ models
  if ('model' in finalLLMConfig && /\bgpt-[5-9](?:\.\d+)?\b/i.test(finalLLMConfig.model ?? '')) {
    // Remove temperature for GPT-5+ models
    delete finalLLMConfig.temperature;

    // Move maxTokens to modelKwargs for GPT-5+ models
    if ('maxTokens' in finalLLMConfig && finalLLMConfig.maxTokens != null) {
      const modelKwargs = (finalLLMConfig as OpenAIClientOptions).modelKwargs ?? {};
      const paramName =
        (finalLLMConfig as OpenAIClientOptions).useResponsesApi === true
          ? 'max_output_tokens'
          : 'max_completion_tokens';
      modelKwargs[paramName] = finalLLMConfig.maxTokens;
      delete finalLLMConfig.maxTokens;
      (finalLLMConfig as OpenAIClientOptions).modelKwargs = modelKwargs;
    }
  }

  const bedrockConfig = finalLLMConfig as {
    additionalModelRequestFields?: { thinking?: unknown };
    temperature?: number;
  };
  if (
    llmConfig?.provider === Providers.BEDROCK &&
    bedrockConfig.additionalModelRequestFields?.thinking != null &&
    bedrockConfig.temperature != null
  ) {
    (finalLLMConfig as unknown as Record<string, unknown>).temperature = 1;
  }

  const anthropicConfig = finalLLMConfig as {
    thinking?: { type?: string };
    temperature?: number;
  };
  if (
    llmConfig?.provider === Providers.ANTHROPIC &&
    anthropicConfig.thinking?.type === 'enabled' &&
    anthropicConfig.temperature != null
  ) {
    delete (finalLLMConfig as Record<string, unknown>).temperature;
  }

  /**
   * Resolve request-based headers across provider-specific carriers (OpenAI
   * `configuration.defaultHeaders`, native Anthropic `clientOptions.defaultHeaders`)
   * so gateway-fronted built-in providers receive resolved metadata/auth headers
   * on memory extraction too. Native Google headers are resolved at init.
   */
  resolveConfigHeaders({
    llmConfig: finalLLMConfig as unknown as RunLLMConfig,
    user: user ? createSafeUser(user) : undefined,
    body: { conversationId, messageId },
  });
  return finalLLMConfig;
}

/** Saved memories are compacted once they pass this share of `tokenLimit`… */
const MEMORY_COMPACT_AT = 0.8;
/** …down to about this share, leaving room for new facts. */
const MEMORY_COMPACT_TARGET = 0.5;

const compactPrompt = (profile: string, targetTokens: number): string =>
  `You tidy a user's saved profile so it stays short. Below is the profile as a JSON object: each key holds facts about the user, oldest first.

Rewrite every key:
- keep every lasting fact; never add or invent facts;
- merge facts that say the same thing;
- when a later fact replaces an earlier one (a new job, a new age), keep only the later one;
- write short plain sentences without gendered pronouns, and keep names exactly as written.

Keep the same keys. Keep the whole profile under about ${targetTokens} tokens.
Reply with only the JSON object.

${profile}`;

function contentText(content: MessageContentComplex[] | string | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  return (content ?? [])
    .map((part) =>
      typeof part === 'object' && part != null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

/** Reads the model's rewritten profile, keeping only keys it already had. */
export function parseCompactedMemories(
  text: string,
  current: ReadonlyMap<string, string>,
): Map<string, string> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const rewritten = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (current.has(key) && typeof value === 'string' && value.trim()) {
      rewritten.set(key, value.trim());
    }
  }
  return rewritten.size > 0 ? rewritten : undefined;
}

/**
 * Asks the memory model to shorten the saved memories and writes the result
 * when it is smaller. Keys the model leaves out are kept as they are.
 * @returns whether anything was rewritten
 */
export async function compactMemories({
  ledger,
  userId,
  agentId,
  setMemory,
  tokenLimit,
  conversationId,
  llmConfig,
  provider,
  customHandlers,
  signal,
}: {
  ledger: MemoryLedger;
  userId: string | ObjectId;
  agentId?: string;
  setMemory: MemoryMethods['setMemory'];
  tokenLimit: number;
  conversationId: string;
  llmConfig: LLMConfig;
  provider?: string;
  customHandlers?: Record<string, EventHandler>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (ledger.valuesByKey.size === 0 || signal?.aborted) {
    return false;
  }
  const before = ledger.totalTokens;
  try {
    const profile = JSON.stringify(Object.fromEntries(ledger.valuesByKey), null, 2);
    const run = await Run.create({
      runId: `memory-compact-${Date.now()}`,
      graphConfig: { type: 'standard', llmConfig, tools: [] },
      customHandlers,
      returnContent: true,
    });
    const content = await run.processStream(
      {
        messages: [
          new HumanMessage(compactPrompt(profile, Math.floor(tokenLimit * MEMORY_COMPACT_TARGET))),
        ],
      },
      {
        runName: 'MemoryCompact',
        configurable: { user_id: userId, thread_id: conversationId, provider },
        streamMode: 'values',
        recursionLimit: 3,
        version: 'v2',
        ...(signal ? { signal } : {}),
      } as const,
    );
    const rewritten = parseCompactedMemories(contentText(content), ledger.valuesByKey);
    if (!rewritten) {
      logger.warn('[MemoryAgent] Compaction returned no usable profile', { userId });
      return false;
    }
    const counts = new Map(
      [...rewritten].map(([key, value]) => [key, countMemoryTokens(value)] as const),
    );
    const after = [...ledger.tokensByKey].reduce(
      (total, [key, tokens]) => total + (counts.get(key) ?? tokens),
      0,
    );
    if (after >= before) {
      logger.warn('[MemoryAgent] Compaction did not shorten memories', { userId, before, after });
      return false;
    }
    for (const [key, value] of rewritten) {
      if (value === ledger.valuesByKey.get(key)) {
        continue;
      }
      const tokenCount = counts.get(key) ?? countMemoryTokens(value);
      const result = await setMemory({ userId, key, value, tokenCount, agentId });
      if (!result.ok) {
        continue;
      }
      ledger.totalTokens += tokenCount - (ledger.tokensByKey.get(key) ?? 0);
      ledger.tokensByKey.set(key, tokenCount);
      ledger.valuesByKey.set(key, value);
    }
    logger.info('[MemoryAgent] Compacted memories', {
      userId,
      before,
      after: ledger.totalTokens,
    });
    return ledger.totalTokens < before;
  } catch (error) {
    if (!signal?.aborted) {
      logger.error('[MemoryAgent] Memory compaction failed', { userId, error });
    }
    return false;
  }
}

export async function processMemory({
  res,
  userId,
  agentId,
  setMemory,
  deleteMemory,
  messages,
  memory,
  messageId,
  conversationId,
  validKeys,
  instructions,
  llmConfig,
  tokenLimit,
  totalTokens = 0,
  tokenCountsByKey,
  valuesByKey,
  streamId = null,
  jobCreatedAt,
  user,
  signal,
  collectedUsage,
}: {
  res: ServerResponse;
  setMemory: MemoryMethods['setMemory'];
  deleteMemory: MemoryMethods['deleteMemory'];
  userId: string | ObjectId;
  /** Agent partition; omit for the shared personal pool */
  agentId?: string;
  memory: string;
  messageId: string;
  conversationId: string;
  messages: BaseMessage[];
  validKeys?: string[];
  instructions: string;
  tokenLimit?: number;
  totalTokens?: number;
  tokenCountsByKey?: ReadonlyMap<string, number>;
  valuesByKey?: ReadonlyMap<string, string>;
  llmConfig?: Partial<LLMConfig>;
  streamId?: string | null;
  jobCreatedAt?: number;
  user?: IUser;
  /** Cancels extraction when the user stops the reply */
  signal?: AbortSignal;
  /** Receives the token usage of each model call in the memory run */
  collectedUsage?: UsageMetadata[];
}): Promise<(TAttachment | null)[] | undefined> {
  try {
    const ledger = createMemoryLedger({ totalTokens, tokenCountsByKey, valuesByKey });
    const finalLLMConfig = buildMemoryLLMConfig({ llmConfig, user, conversationId, messageId });
    const usageHandlersFor = (runId: string): Record<string, EventHandler> =>
      collectedUsage
        ? {
            [GraphEvents.CHAT_MODEL_END]: createMemoryUsageHandler(
              collectedUsage,
              runId,
              llmConfig,
            ),
          }
        : {};
    const usageHandlers = usageHandlersFor(randomUUID());
    const compact = tokenLimit
      ? () =>
          compactMemories({
            ledger,
            userId,
            agentId,
            setMemory,
            tokenLimit,
            conversationId,
            llmConfig: finalLLMConfig,
            provider: llmConfig?.provider,
            customHandlers: usageHandlersFor(randomUUID()),
            signal,
          })
      : undefined;
    const memoryTool = createMemoryTool({
      userId,
      agentId,
      tokenLimit,
      setMemory,
      validKeys,
      ledger,
      compact,
    });
    const deleteMemoryTool = createDeleteMemoryTool({
      userId,
      agentId,
      validKeys,
      deleteMemory,
      ledger,
    });

    const currentMemoryTokens = totalTokens;

    let memoryStatus = `# Existing memory:\n${memory ?? 'No existing memories'}`;

    if (tokenLimit) {
      const remainingTokens = Math.max(tokenLimit - currentMemoryTokens, 0);
      memoryStatus = `# Memory Status:
Current memory usage: ${currentMemoryTokens} tokens
Token limit: ${tokenLimit} tokens
Remaining capacity: ${remainingTokens} tokens

# Existing memory:
${memory ?? 'No existing memories'}`;
    }

    const artifactPromises: Promise<TAttachment | null>[] = [];
    const memoryCallback = createMemoryCallback({
      res,
      artifactPromises,
      streamId,
      jobCreatedAt,
    });
    const customHandlers = {
      [GraphEvents.TOOL_END]: new BasicToolEndHandler(memoryCallback),
      ...usageHandlers,
    };

    /**
     * For Bedrock provider, include instructions in the user message instead of as a system prompt.
     * Bedrock's Converse API requires conversations to start with a user message, not a system message.
     * Other providers can use the standard system prompt approach.
     */
    const isBedrock = llmConfig?.provider === Providers.BEDROCK;

    let graphInstructions: string | undefined = instructions;
    let graphAdditionalInstructions: string | undefined = memoryStatus;
    let processedMessages = messages;

    if (isBedrock) {
      const combinedInstructions = [instructions, memoryStatus].filter(Boolean).join('\n\n');

      if (messages.length > 0) {
        const firstMessage = messages[0];
        const originalContent =
          typeof firstMessage.content === 'string' ? firstMessage.content : '';

        if (typeof firstMessage.content !== 'string') {
          logger.warn(
            'Bedrock memory processing: First message has non-string content, using empty string',
          );
        }

        const bedrockUserMessage = new HumanMessage(
          `${combinedInstructions}\n\n${originalContent}`,
        );
        processedMessages = [bedrockUserMessage, ...messages.slice(1)];
      } else {
        processedMessages = [new HumanMessage(combinedInstructions)];
      }

      graphInstructions = undefined;
      graphAdditionalInstructions = undefined;
    }

    const run = await Run.create({
      runId: messageId,
      graphConfig: {
        type: 'standard',
        llmConfig: finalLLMConfig,
        tools: [memoryTool, deleteMemoryTool],
        instructions: graphInstructions,
        additional_instructions: graphAdditionalInstructions,
        toolEnd: true,
      },
      customHandlers,
      returnContent: true,
    });

    const config = {
      runName: 'MemoryRun',
      configurable: {
        user_id: userId,
        thread_id: conversationId,
        provider: llmConfig?.provider,
      },
      streamMode: 'values',
      recursionLimit: 3,
      version: 'v2',
      ...(signal ? { signal } : {}),
    } as const;

    const inputs = {
      messages: processedMessages,
    };
    const content = await run.processStream(inputs, config);
    if (content) {
      logger.debug('[MemoryAgent] Processed successfully', {
        userId,
        conversationId,
        messageId,
        provider: llmConfig?.provider,
      });
    } else {
      logger.debug('[MemoryAgent] Returned no content', { userId, conversationId, messageId });
    }
    const attachments = await Promise.all(artifactPromises);
    if (compact && !signal?.aborted && ledger.totalTokens > tokenLimit! * MEMORY_COMPACT_AT) {
      await compact();
    }
    return attachments;
  } catch (error) {
    if (signal?.aborted) {
      logger.debug('[MemoryAgent] Stopped with the reply', { userId, conversationId, messageId });
      return;
    }
    logger.error(
      `[MemoryAgent] Failed to process memory | userId: ${userId} | conversationId: ${conversationId} | messageId: ${messageId}`,
      { error },
    );
  }
}

export async function createMemoryProcessor({
  res,
  userId,
  agentId,
  messageId,
  memoryMethods,
  conversationId,
  config = {},
  streamId = null,
  jobCreatedAt,
  user,
}: {
  res: ServerResponse;
  messageId: string;
  conversationId: string;
  userId: string | ObjectId;
  /** Agent partition; omit for the shared personal pool */
  agentId?: string;
  memoryMethods: RequiredMemoryMethods;
  config?: MemoryConfig;
  streamId?: string | null;
  jobCreatedAt?: number;
  user?: IUser;
}): Promise<
  [
    string,
    (
      messages: BaseMessage[],
      options?: MemoryRunOptions,
    ) => Promise<(TAttachment | null)[] | undefined>,
  ]
> {
  const { validKeys, instructions, llmConfig, tokenLimit } = config;
  const finalInstructions = instructions || getDefaultInstructions(validKeys, tokenLimit);

  const { withKeys, withoutKeys, totalTokens, tokenCountsByKey, valuesByKey } =
    await memoryMethods.getFormattedMemories({
      userId,
      agentId,
    });

  return [
    withoutKeys,
    async function (
      messages: BaseMessage[],
      options?: MemoryRunOptions,
    ): Promise<(TAttachment | null)[] | undefined> {
      try {
        return await processMemory({
          res,
          userId,
          agentId,
          messages,
          validKeys,
          llmConfig,
          messageId,
          tokenLimit,
          streamId,
          jobCreatedAt,
          conversationId,
          memory: withKeys,
          totalTokens: totalTokens || 0,
          tokenCountsByKey,
          valuesByKey,
          instructions: finalInstructions,
          setMemory: memoryMethods.setMemory,
          deleteMemory: memoryMethods.deleteMemory,
          user,
          signal: options?.signal,
          collectedUsage: options?.collectedUsage,
        });
      } catch (error) {
        logger.error('Memory Agent failed to process memory', error);
      }
    },
  ];
}

async function handleMemoryArtifact({
  res,
  data,
  metadata,
  streamId = null,
  jobCreatedAt,
}: {
  res: ServerResponse;
  data: ToolEndData;
  metadata?: ToolEndMetadata;
  streamId?: string | null;
  jobCreatedAt?: number;
}) {
  const output = data?.output as ToolMessage | undefined;
  if (!output) {
    return null;
  }

  if (!output.artifact) {
    return null;
  }

  const memoryArtifact = output.artifact[Tools.memory] as MemoryArtifact | undefined;
  if (!memoryArtifact) {
    return null;
  }

  const attachment: Partial<TAttachment> = {
    type: Tools.memory,
    toolCallId: output.tool_call_id,
    messageId: metadata?.run_id ?? '',
    conversationId: metadata?.thread_id ?? '',
    [Tools.memory]: memoryArtifact,
  };
  if (!res.headersSent) {
    return attachment;
  }
  if (streamId) {
    GenerationJobManager.emitChunk(
      streamId,
      { event: 'attachment', data: attachment },
      { expectedCreatedAt: jobCreatedAt },
    );
  } else {
    writeGuarded(res, `event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
  return attachment;
}

/**
 * Creates a memory callback for handling memory artifacts
 * @param params - The parameters object
 * @param params.res - The server response object
 * @param params.artifactPromises - Array to collect artifact promises
 * @param params.streamId - The stream ID for resumable mode, or null for standard mode
 * @param params.jobCreatedAt - The generation epoch that owns emitted artifacts
 * @returns The memory callback function
 */
export function createMemoryCallback({
  res,
  artifactPromises,
  streamId = null,
  jobCreatedAt,
}: {
  res: ServerResponse;
  artifactPromises: Promise<Partial<TAttachment> | null>[];
  streamId?: string | null;
  jobCreatedAt?: number;
}): ToolEndCallback {
  return async (data: ToolEndData, metadata?: Record<string, unknown>) => {
    const output = data?.output as ToolMessage | undefined;
    const memoryArtifact = output?.artifact?.[Tools.memory] as MemoryArtifact;
    if (memoryArtifact == null) {
      return;
    }
    artifactPromises.push(
      handleMemoryArtifact({ res, data, metadata, streamId, jobCreatedAt }).catch((error) => {
        logger.error('Error processing memory artifact content:', error);
        return null;
      }),
    );
  };
}
