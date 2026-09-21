import { Tools, FileSources, getCodeEnvRefs } from 'librechat-data-provider';
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

/** Where an attachment's content lives when it was not pasted into the conversation. */
function describeAttachmentRoutes(file: IMongoFile): string[] {
  const routes: string[] = [];
  if (file.embedded === true) {
    routes.push('indexed for search');
  }
  if (getCodeEnvRefs(file.metadata).length > 0) {
    routes.push('in the code sandbox');
  }
  return routes;
}

/** Whether the model can already read or reach this attachment on its own. */
function isAttachmentReachable(file: IMongoFile, tools: Set<string>): boolean {
  if (file.type?.startsWith('image/') === true) {
    return true;
  }
  if (file.source === FileSources.text || file.metadata?.preparation?.contextText === true) {
    return true;
  }
  if (file.embedded === true && tools.has(Tools.file_search)) {
    return true;
  }
  return getCodeEnvRefs(file.metadata).length > 0 && tools.has(Tools.execute_code);
}

/**
 * Names the attachments an agent was handed but cannot open.
 *
 * A long document is indexed for search or copied into the code sandbox rather than pasted into
 * the conversation, and the only other mention of it is the note each of those tools adds for
 * itself. An agent holding neither — an orchestrator such as the Office Assistant — therefore
 * received the user's words and no sign of the file at all, told the user nothing was attached,
 * and never handed the work to the specialist that could have read it.
 */
export function buildUnreachableAttachmentsNote({
  attachments,
  tools,
}: {
  attachments: IMongoFile[];
  tools: string[];
}): string | undefined {
  const toolSet = new Set(tools);
  const lines = attachments.flatMap((file) => {
    if (!file.filename || isAttachmentReachable(file, toolSet)) {
      return [];
    }
    const routes = describeAttachmentRoutes(file);
    return [`\n\t- ${file.filename}${routes.length > 0 ? ` (${routes.join(', ')})` : ''}`];
  });

  if (lines.length === 0) {
    return undefined;
  }

  return (
    '- Note: The user attached these files to this message. They arrived, but their contents ' +
    'are not shown to you and you have no tool to open them, so never tell the user that ' +
    'nothing is attached or ask them to upload the files again. Hand the work to the ' +
    `specialist whose tools can read them:${lines.join('')}`
  );
}
