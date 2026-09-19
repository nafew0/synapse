import type { IMongoFile } from '@librechat/data-schemas';
import type { TokenCountFn } from '~/utils/text';
import type { ServerRequest } from '~/types';
import { countTokens } from '~/utils/tokenizer';
import { extractFileContext } from '~/files';

type FileWithId = {
  file_id?: string | null;
};

export type AgentContextAttachmentCarrier<TFile extends FileWithId = IMongoFile> = {
  id?: string | null;
  agentContextAttachments?: TFile[] | null;
  subagentAgentConfigs?: AgentContextAttachmentCarrier<TFile>[] | null;
  subagentGraphConfigs?: Array<{
    memberConfigs?: AgentContextAttachmentCarrier<TFile>[] | null;
  }> | null;
};

export type AgentContextAttachmentsByAgentId<TFile extends FileWithId = IMongoFile> =
  | Map<string, TFile[]>
  | Record<string, TFile[] | undefined>
  | null
  | undefined;

export function collectFileIds<TFile extends FileWithId>(
  files?: Array<TFile | null | undefined> | null,
): Set<string> {
  const fileIds = new Set<string>();
  for (const file of files ?? []) {
    if (file?.file_id) {
      fileIds.add(file.file_id);
    }
  }
  return fileIds;
}

export function buildAgentContextAttachmentsByAgentId<TFile extends FileWithId>(
  configs: Iterable<AgentContextAttachmentCarrier<TFile> | null | undefined>,
): Map<string, TFile[]> {
  const attachmentsByAgentId = new Map<string, TFile[]>();
  const visited = new Set<string>();
  const pending = [...configs];

  for (let index = 0; index < pending.length; index++) {
    const config = pending[index];
    if (!config?.id || visited.has(config.id)) {
      continue;
    }
    visited.add(config.id);
    if (config.agentContextAttachments?.length) {
      attachmentsByAgentId.set(config.id, config.agentContextAttachments);
    }
    pending.push(...(config.subagentAgentConfigs ?? []));
    for (const graph of config.subagentGraphConfigs ?? []) {
      pending.push(...(graph.memberConfigs ?? []));
    }
  }

  return attachmentsByAgentId;
}

export function getAgentContextAttachments<TFile extends FileWithId>({
  agentId,
  attachmentsByAgentId,
  excludeFileIds,
}: {
  agentId: string;
  attachmentsByAgentId: AgentContextAttachmentsByAgentId<TFile>;
  excludeFileIds?: Set<string>;
}): TFile[] {
  if (!attachmentsByAgentId) {
    return [];
  }

  const attachments: TFile[] =
    attachmentsByAgentId instanceof Map
      ? (attachmentsByAgentId.get(agentId) ?? [])
      : (attachmentsByAgentId[agentId] ?? []);

  if (!excludeFileIds || excludeFileIds.size === 0) {
    return attachments;
  }

  return attachments.filter((file) => !file?.file_id || !excludeFileIds.has(file.file_id));
}

export async function buildAgentScopedContext({
  agentIds,
  attachmentsByAgentId,
  sharedRunAttachmentIds,
  req,
  tokenCountFn = countTokens,
}: {
  agentIds: string[];
  attachmentsByAgentId: AgentContextAttachmentsByAgentId<IMongoFile>;
  sharedRunAttachmentIds?: Set<string>;
  req?: ServerRequest;
  tokenCountFn?: TokenCountFn;
}): Promise<Map<string, string>> {
  const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)));
  const entries = await Promise.all(
    uniqueAgentIds.map(async (agentId) => {
      const attachments = getAgentContextAttachments({
        agentId,
        attachmentsByAgentId,
        excludeFileIds: sharedRunAttachmentIds,
      });
      if (attachments.length === 0) {
        return [agentId, ''] as const;
      }

      const context = await extractFileContext({
        attachments,
        req,
        tokenCountFn,
      });
      return [agentId, context ?? ''] as const;
    }),
  );

  return new Map(entries.filter(([, context]) => Boolean(context)));
}

/** The fields an artifact can be identified by, cheapest and most stable first. */
interface ArtifactAttachment {
  file_id?: string | null;
  filepath?: string | null;
  filename?: string | null;
}

/**
 * One entry per artifact, however many times the turn emitted it.
 *
 * A tool that writes the same path more than once in a turn — a deck rebuilt
 * twice by its own visual-QA loop, a workbook corrected after a failed check —
 * resolves one artifact promise per write. The file record is already upserted
 * by `file_id`, so those writes collapse to a single stored file, but the
 * message kept every emission and the chat showed the same deck three times.
 *
 * Keyed the same way `mergeAttachments` keys the resumed path, so a turn that
 * pauses and one that does not agree on what the message holds. Position comes
 * from the first emission (the order the user watched them arrive); the value
 * comes from the last, which carries the newest size and lifecycle status.
 */
export function dedupeAttachments<T extends ArtifactAttachment>(attachments: T[]): T[] {
  if (attachments.length < 2) {
    return attachments;
  }
  const byArtifact = new Map<string | symbol, T>();
  for (const attachment of attachments) {
    const key = attachment.file_id ?? attachment.filepath ?? attachment.filename;
    /** An artifact with nothing to identify it cannot be proven a duplicate. */
    byArtifact.set(key == null || key === '' ? Symbol() : key, attachment);
  }
  return [...byArtifact.values()];
}
