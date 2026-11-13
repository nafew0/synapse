import type { Model, Types } from 'mongoose';
import type {
  IKbIngestJob,
  IKbDocument,
  KbParserInfo,
  IKbIngestJobDoc,
  IKbDocumentDoc,
  IKbDocumentVersion,
  IKbDocumentVersionDoc,
} from '~/types';
import type { KbDocType, KbDocumentStatus } from '~/common';
import { KbLimits, KbDocumentStatuses, KbIngestJobStatuses } from '~/common';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export type KbFileInput = {
  fileRef: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
};

export type CreateKbDocumentInput = {
  title: string;
  docType?: KbDocType;
  file: KbFileInput;
  createdBy?: string | null;
};

export type KbQueuedResult = {
  document: IKbDocument;
  job: IKbIngestJob;
};

export type CompleteKbIngestInput = {
  jobId: string | Types.ObjectId;
  pageCount: number;
  chunkCount: number;
  unreadablePages: number[];
  parser: KbParserInfo;
};

export type FailKbIngestInput = {
  jobId: string | Types.ObjectId;
  error: string;
  /** False when retrying cannot help, e.g. a file the parser rejects. */
  retryable?: boolean;
  now?: Date;
};

export type KbUsage = {
  documents: number;
  bytes: number;
};

export interface KbMethods {
  createKbDocument(input: CreateKbDocumentInput): Promise<KbQueuedResult>;
  addKbDocumentVersion(
    documentId: string,
    file: KbFileInput,
    uploadedBy?: string | null,
  ): Promise<KbQueuedResult>;
  getKbDocument(documentId: string): Promise<IKbDocument | null>;
  listKbDocuments(filter?: { status?: KbDocumentStatus }): Promise<IKbDocument[]>;
  getKbDocumentVersion(documentId: string, version: number): Promise<IKbDocumentVersion | null>;
  getKbUsage(): Promise<KbUsage>;
  /** Whether this tenant has anything searchable; read on every chat turn, so one indexed query. */
  hasReadyKbDocuments(tenantId: string): Promise<boolean>;
  updateKbDocument(
    documentId: string,
    update: { title?: string; docType?: KbDocType; updatedBy?: string | null },
  ): Promise<IKbDocument | null>;
  listKbDocumentVersions(documentId: string): Promise<IKbDocumentVersion[]>;
  /** Claims the next runnable job across tenants. Call inside `runAsSystem`. */
  claimKbIngestJob(now?: Date): Promise<IKbIngestJob | null>;
  completeKbIngestJob(input: CompleteKbIngestInput): Promise<{ prunedFileRefs: string[] }>;
  failKbIngestJob(input: FailKbIngestInput): Promise<{ retrying: boolean }>;
  deleteKbDocument(documentId: string): Promise<{ fileRefs: string[] }>;
}

/** Knowledge base rows always belong to one institution, so creating one needs a tenant context. */
const requireTenant = (): string => {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    throw new Error('Knowledge base documents need an institution (tenant) context');
  }
  return tenantId;
};

/** Retry after 1, 4, 9… minutes. */
const retryDelayMs = (attempts: number): number => attempts * attempts * 60_000;

export function createKbMethods(mongoose: typeof import('mongoose')): KbMethods {
  const documents = () => mongoose.models.KbDocument as Model<IKbDocumentDoc>;
  const versions = () => mongoose.models.KbDocumentVersion as Model<IKbDocumentVersionDoc>;
  const jobs = () => mongoose.models.KbIngestJob as Model<IKbIngestJobDoc>;

  async function queueVersion(
    document: IKbDocumentDoc,
    version: number,
    file: KbFileInput,
    uploadedBy: string | null,
  ): Promise<IKbIngestJob> {
    await versions().create({
      tenantId: document.tenantId,
      documentId: document._id,
      version,
      uploadedBy,
      ...file,
    });
    const job = await jobs().create({
      tenantId: document.tenantId,
      documentId: document._id,
      version,
    });
    return job.toObject() as IKbIngestJob;
  }

  async function createKbDocument(input: CreateKbDocumentInput): Promise<KbQueuedResult> {
    const title = input.title.trim();
    if (!title) {
      throw new Error('A knowledge base document needs a title');
    }
    const document = await documents().create({
      tenantId: requireTenant(),
      title,
      docType: input.docType ?? 'other',
      filename: input.file.filename,
      mimeType: input.file.mimeType,
      sizeBytes: input.file.sizeBytes,
      latestVersion: 1,
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
    });
    const job = await queueVersion(document, 1, input.file, input.createdBy ?? null);
    return { document: document.toObject() as IKbDocument, job };
  }

  async function addKbDocumentVersion(
    documentId: string,
    file: KbFileInput,
    uploadedBy: string | null = null,
  ): Promise<KbQueuedResult> {
    const latest = await versions()
      .findOne({ documentId })
      .sort({ version: -1 })
      .select('sha256')
      .lean();
    if (latest?.sha256 === file.sha256) {
      throw new Error('This file is the same as the latest version');
    }
    const document = await documents().findOneAndUpdate(
      { _id: documentId },
      {
        $inc: { latestVersion: 1 },
        $set: {
          status: KbDocumentStatuses.QUEUED,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          error: null,
          updatedBy: uploadedBy,
        },
      },
      { new: true },
    );
    if (!document) {
      throw new Error('Knowledge base document not found');
    }
    const job = await queueVersion(document, document.latestVersion, file, uploadedBy);
    return { document: document.toObject() as IKbDocument, job };
  }

  async function getKbDocument(documentId: string): Promise<IKbDocument | null> {
    return (await documents().findOne({ _id: documentId }).lean()) as IKbDocument | null;
  }

  async function listKbDocuments(filter: { status?: KbDocumentStatus } = {}) {
    const query = filter.status ? { status: filter.status } : {};
    return (await documents().find(query).sort({ updatedAt: -1 }).lean()) as IKbDocument[];
  }

  async function getKbDocumentVersion(documentId: string, version: number) {
    return (await versions().findOne({ documentId, version }).lean()) as IKbDocumentVersion | null;
  }

  async function getKbUsage(): Promise<KbUsage> {
    const [usage] = await documents().aggregate<KbUsage>([
      { $group: { _id: null, documents: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } },
      { $project: { _id: 0, documents: 1, bytes: 1 } },
    ]);
    return usage ?? { documents: 0, bytes: 0 };
  }

  async function hasReadyKbDocuments(tenantId: string): Promise<boolean> {
    const found = await documents()
      .exists({ tenantId, currentVersion: { $gt: 0 } })
      .lean();
    return found != null;
  }

  async function updateKbDocument(
    documentId: string,
    update: { title?: string; docType?: KbDocType; updatedBy?: string | null },
  ): Promise<IKbDocument | null> {
    const set: Partial<Pick<IKbDocument, 'title' | 'docType'>> & { updatedBy?: string | null } = {};
    const title = update.title?.trim();
    if (title) {
      set.title = title;
    }
    if (update.docType) {
      set.docType = update.docType;
    }
    if (update.updatedBy !== undefined) {
      set.updatedBy = update.updatedBy;
    }
    return (await documents()
      .findOneAndUpdate({ _id: documentId }, { $set: set }, { new: true, runValidators: true })
      .lean()) as IKbDocument | null;
  }

  async function listKbDocumentVersions(documentId: string): Promise<IKbDocumentVersion[]> {
    return (await versions()
      .find({ documentId })
      .sort({ version: -1 })
      .lean()) as IKbDocumentVersion[];
  }

  async function claimKbIngestJob(now: Date = new Date()): Promise<IKbIngestJob | null> {
    const abandoned = new Date(now.getTime() - KbLimits.ingestLeaseMs);
    const job = await jobs().findOneAndUpdate(
      {
        $or: [
          { status: KbIngestJobStatuses.QUEUED, availableAt: { $lte: now } },
          { status: KbIngestJobStatuses.PROCESSING, lockedAt: { $lte: abandoned } },
        ],
      },
      {
        $set: { status: KbIngestJobStatuses.PROCESSING, lockedAt: now },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { availableAt: 1 } },
    );
    if (!job) {
      return null;
    }
    await documents().updateOne(
      { _id: job.documentId, latestVersion: job.version },
      { $set: { status: KbDocumentStatuses.PROCESSING } },
    );
    return job.toObject() as IKbIngestJob;
  }

  /** Drops versions beyond the newest `maxVersionsKept`, never the current one. */
  async function pruneVersions(documentId: Types.ObjectId, current: number): Promise<string[]> {
    const stale = await versions()
      .find({ documentId, version: { $ne: current } })
      .sort({ version: -1 })
      .skip(KbLimits.maxVersionsKept - 1)
      .select('_id fileRef')
      .lean();
    if (stale.length === 0) {
      return [];
    }
    await versions().deleteMany({ _id: { $in: stale.map((v) => v._id) } });
    return stale.map((v) => v.fileRef);
  }

  async function completeKbIngestJob(input: CompleteKbIngestInput) {
    const job = await jobs().findOneAndUpdate(
      { _id: input.jobId, status: KbIngestJobStatuses.PROCESSING },
      { $set: { status: KbIngestJobStatuses.DONE, error: null, lockedAt: null } },
      { new: true },
    );
    if (!job) {
      throw new Error('Ingest job is not being processed');
    }
    const indexed = {
      indexedAt: new Date(),
      parser: input.parser,
      pageCount: input.pageCount,
      chunkCount: input.chunkCount,
    };
    await versions().updateOne(
      { documentId: job.documentId, version: job.version },
      { $set: indexed },
    );
    const document = await documents().findOneAndUpdate(
      { _id: job.documentId, currentVersion: { $lt: job.version } },
      {
        $set: {
          currentVersion: job.version,
          pageCount: input.pageCount,
          chunkCount: input.chunkCount,
          unreadablePages: input.unreadablePages,
        },
      },
      { new: true },
    );
    if (!document) {
      return { prunedFileRefs: [] };
    }
    if (document.latestVersion === job.version) {
      await documents().updateOne(
        { _id: document._id },
        { $set: { status: KbDocumentStatuses.READY, error: null } },
      );
    }
    return { prunedFileRefs: await pruneVersions(document._id, job.version) };
  }

  async function failKbIngestJob(input: FailKbIngestInput) {
    const now = input.now ?? new Date();
    const job = await jobs().findOne({ _id: input.jobId });
    if (!job) {
      throw new Error('Ingest job not found');
    }
    const retrying = input.retryable !== false && job.attempts < KbLimits.maxIngestAttempts;
    await jobs().updateOne(
      { _id: job._id },
      {
        $set: retrying
          ? {
              status: KbIngestJobStatuses.QUEUED,
              availableAt: new Date(now.getTime() + retryDelayMs(job.attempts)),
              lockedAt: null,
              error: input.error,
            }
          : { status: KbIngestJobStatuses.FAILED, lockedAt: null, error: input.error },
      },
    );
    if (retrying) {
      await documents().updateOne(
        { _id: job.documentId, latestVersion: job.version },
        { $set: { status: KbDocumentStatuses.QUEUED, error: `Retrying: ${input.error}` } },
      );
      return { retrying };
    }
    const document = await documents().findOne({ _id: job.documentId });
    if (document && document.latestVersion === job.version) {
      const live = document.currentVersion > 0;
      await documents().updateOne(
        { _id: document._id },
        {
          $set: {
            status: live ? KbDocumentStatuses.READY : KbDocumentStatuses.FAILED,
            error: live ? `Version ${job.version} failed: ${input.error}` : input.error,
          },
        },
      );
    }
    return { retrying };
  }

  async function deleteKbDocument(documentId: string) {
    const all = await versions().find({ documentId }).select('fileRef').lean();
    await Promise.all([
      jobs().deleteMany({ documentId }),
      versions().deleteMany({ documentId }),
      documents().deleteOne({ _id: documentId }),
    ]);
    return { fileRefs: all.map((v) => v.fileRef) };
  }

  return {
    createKbDocument,
    addKbDocumentVersion,
    getKbDocument,
    listKbDocuments,
    getKbDocumentVersion,
    getKbUsage,
    hasReadyKbDocuments,
    updateKbDocument,
    listKbDocumentVersions,
    claimKbIngestJob,
    completeKbIngestJob,
    failKbIngestJob,
    deleteKbDocument,
  };
}
