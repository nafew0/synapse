import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';

/**
 * Tenant-scoped records a person's own work leaves behind, as `[model, owner field]`. Login
 * artefacts (sessions, tokens, balance) and usage rows are not listed: a user who only signed in
 * has them. Moving someone who owns any of these would strand it in the tenant it was written in.
 */
const OWNED_RECORDS: ReadonlyArray<readonly [string, string]> = [
  ['Conversation', 'user'],
  ['Message', 'user'],
  ['File', 'user'],
  ['Agent', 'author'],
  ['MemoryEntry', 'userId'],
  ['PromptGroup', 'author'],
  ['Prompt', 'author'],
  ['Preset', 'user'],
  ['Key', 'userId'],
  ['SharedLink', 'user'],
  ['Assistant', 'user'],
  ['ToolCall', 'user'],
  ['ChatProject', 'user'],
  ['Skill', 'author'],
  ['MCPServer', 'author'],
  ['AgentApiKey', 'userId'],
  ['ToolFavorite', 'user'],
  ['ConversationTag', 'user'],
  ['Action', 'user'],
  ['PluginAuth', 'userId'],
  ['KbDocument', 'createdBy'],
];

/** Whether the user owns any tenant-scoped record, checked with one cheap `exists` per model, in parallel. */
export async function userOwnsData(userId: string): Promise<boolean> {
  const found = await runAsSystem(() =>
    Promise.all(
      OWNED_RECORDS.map(
        ([name, field]) => mongoose.models[name]?.exists({ [field]: userId }).exec() ?? null,
      ),
    ),
  );
  return found.some((hit) => hit != null);
}
