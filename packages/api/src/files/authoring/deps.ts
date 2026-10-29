import { randomUUID } from 'crypto';
import { FileContext } from 'librechat-data-provider';
import { Types } from 'mongoose';
import type { FilterQuery } from 'mongoose';
import type { IMongoFile } from '@librechat/data-schemas';
import type { AuthoringFile, FileAuthoringDeps } from './tools';
import { truncateCachedText } from '../code/extract';

/** Where a stored copy lives, as returned by the deployment's storage strategy. */
export type StoredCopy = Partial<IMongoFile> & { filepath: string; source: string };

export interface FileAuthoringContext {
  userId: string;
  tenantId?: string;
  conversationId?: string;
  /** File ids attached to the message being answered; a new conversation has no file list yet. */
  requestFileIds: string[];
  getConvoFiles: (conversationId: string) => Promise<string[] | null>;
  getFiles: (
    filter: FilterQuery<IMongoFile>,
    sortOptions?: null,
    selectFields?: string,
  ) => Promise<IMongoFile[] | null>;
  createFile: (data: Partial<IMongoFile>, disableTTL?: boolean) => Promise<IMongoFile | null>;
  /** Reads a stored file's bytes through its storage strategy; `null` when there is none. */
  readStored: (file: IMongoFile) => Promise<Buffer | null>;
  /** Writes bytes through the deployment's storage strategy. */
  storeBuffer: (params: { fileName: string; buffer: Buffer }) => Promise<StoredCopy>;
  /** Retention fields for a new chat file, e.g. `expiresAt`. */
  getRetention: () => Promise<Partial<IMongoFile>>;
}

/**
 * Whether the record's `text` is the whole file: what these tools saved, or an upload delivered in
 * full. A searched upload keeps only a preview there, so its original is read from storage instead.
 */
function hasCompleteText(file: IMongoFile): boolean {
  if (file.context === FileContext.file_authoring) {
    return true;
  }
  const preparation = (file.metadata as { preparation?: { delivery?: string } } | undefined)
    ?.preparation;
  return preparation?.delivery === 'full_text';
}

const toAuthoringFile = (file: IMongoFile): AuthoringFile => ({
  file_id: file.file_id,
  filename: file.filename,
  type: file.type,
  hasCompleteText: hasCompleteText(file),
  updatedAt: file.updatedAt,
});

/**
 * Builds the storage side of the file tools for one request. Every lookup is scoped to the
 * requesting user, so a file id from another account is never readable.
 */
export function createFileAuthoringDeps(context: FileAuthoringContext): FileAuthoringDeps {
  const { userId, tenantId, conversationId, requestFileIds } = context;
  const records = new Map<string, IMongoFile>();

  const listFiles = async (): Promise<AuthoringFile[]> => {
    const convoFileIds = conversationId
      ? ((await context.getConvoFiles(conversationId)) ?? [])
      : [];
    const fileIds = [...new Set([...requestFileIds, ...convoFileIds])];
    const scopes: FilterQuery<IMongoFile>[] = [{ file_id: { $in: fileIds } }];
    if (conversationId) {
      scopes.push({ conversationId, context: FileContext.file_authoring });
    }
    const files = (await context.getFiles({ user: userId, $or: scopes })) ?? [];
    return files.map((file) => {
      records.set(file.file_id, file);
      return toAuthoringFile(file);
    });
  };

  const readContent = async (file: AuthoringFile): Promise<string | null> => {
    const record = records.get(file.file_id);
    if (!record) {
      return null;
    }
    if (file.hasCompleteText) {
      const [withText] =
        (await context.getFiles({ user: userId, file_id: record.file_id }, null, 'text')) ?? [];
      return withText?.text ?? null;
    }
    if (!record.filepath) {
      return null;
    }
    const buffer = await context.readStored(record);
    return buffer ? buffer.toString('utf8') : null;
  };

  const saveFile: FileAuthoringDeps['saveFile'] = async ({ filename, content, type }) => {
    const file_id = randomUUID();
    const buffer = Buffer.from(content, 'utf8');
    const stored = await context.storeBuffer({ fileName: `${file_id}__${filename}`, buffer });
    const record: Partial<IMongoFile> = {
      ...stored,
      ...(await context.getRetention()),
      file_id,
      user: new Types.ObjectId(userId),
      ...(tenantId ? { tenantId } : {}),
      conversationId,
      object: 'file',
      filename,
      type,
      bytes: buffer.length,
      text: content,
      textFormat: 'text',
      context: FileContext.file_authoring,
      usage: 0,
    };
    const created = await context.createFile(record, true);
    if (!created) {
      throw new Error(`File record for "${filename}" was not created`);
    }
    /** The attachment carries the preview text, capped like sandbox outputs; the record keeps it all. */
    return { ...created, text: truncateCachedText(content), hasCompleteText: true };
  };

  return { listFiles, readContent, saveFile };
}
