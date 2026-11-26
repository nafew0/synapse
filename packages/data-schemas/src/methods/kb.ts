import type { Model, Types } from 'mongoose';
import type {
  IKbIngestJob,
  IKbDocument,
  KbParserInfo,
  IKbDocumentDoc,
  IKbStorageDaily,
  IKbIngestJobDoc,
  KbStorageFigures,
  IKbDocumentVersion,
  IKbStorageDailyDoc,
  IKbDocumentVersionDoc,
} from '~/types';
import type { KbDocType, KbDocumentStatus } from '~/common';
import { KbLimits, KbDocumentStatuses, KbIngestJobStatuses } from '~/common';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';

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
  /** Parsed text bytes this version sent to the search index. */
  parsedBytes?: number;
};

export type FailKbIngestInput = {
  jobId: string | Types.ObjectId;
  error: string;
  /** False when retrying cannot help, e.g. a file the parser rejects. */
  retryable?: boolean;
  now?: Date;
};

export type KbCatalogEntry = {
  id: string;
  title: string;
  docType: KbDocType;
};

export type KbUsage = {
  documents: number;
  /** Live documents' current files: what the storage limit counts. */
  bytes: number;
  /** Every stored version, the live ones included. */
  versions: number;
  /** Originals of every stored version plus their parsed text. */
  totalBytes: number;
};

export type KbTenantStorage = KbStorageFigures & { tenantId: string };

export type KbStorageDailyInput = KbTenantStorage & { day: string; measuredAt: Date };

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
  /**
   * Storage figures per tenant, from the sizes recorded at write time: one tenant, or every
   * tenant with records. Call inside `runAsSystem`.
   */
  measureKbStorage(tenantId?: string): Promise<KbTenantStorage[]>;
  /**
   * Writes each row as its tenant's figures for that day, unless the day already holds a later
   * measurement. Call inside `runAsSystem`.
   */
  saveKbStorageDaily(rows: KbStorageDailyInput[]): Promise<void>;
  /** Daily rows from `fromDay` on, oldest first; inside a tenant context only that tenant's. */
  listKbStorageDaily(filter: { fromDay: string; tenantId?: string }): Promise<IKbStorageDaily[]>;
  /** Whether this tenant has anything searchable; read on every chat turn, so one indexed query. */
  hasReadyKbDocuments(tenantId: string): Promise<boolean>;
  /** A tenant's searchable documents, newest first: the chat prompt lists them, search keeps to them. */
  listReadyKbCatalog(tenantId: string, limit?: number): Promise<KbCatalogEntry[]>;
  /** Every document record a tenant has, in any state, for reconciling the search index. */
  listKbDocumentIds(tenantId: string): Promise<string[]>;
  /** Institutions plus any tenant with knowledge base records. Call inside `runAsSystem`. */
  listKbTenantIds(): Promise<string[]>;
  updateKbDocument(
    documentId: string,
    update: { title?: string; docType?: KbDocType; updatedBy?: string | null },
  ): Promise<IKbDocument | null>;
  listKbDocumentVersions(documentId: string): Promise<IKbDocumentVersion[]>;
  /** Claims the next runnable job across tenants. Call inside `runAsSystem`. */
  claimKbIngestJob(now?: Date): Promise<IKbIngestJob | null>;
  /** Extends a running job's lease so no other worker reclaims it. Call inside `runAsSystem`. */
  renewKbIngestJob(jobId: Types.ObjectId | string, now?: Date): Promise<void>;
  completeKbIngestJob(input: CompleteKbIngestInput): Promise<{ prunedFileRefs: string[] }>;
  failKbIngestJob(input: FailKbIngestInput): Promise<{ retrying: boolean }>;
  deleteKbDocument(documentId: string): Promise<{ fileRefs: string[] }>;
  /** Queues the latest version again after it failed. Null when there is nothing to retry. */
  retryKbDocument(documentId: string): Promise<IKbDocument | null>;
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
  const storageDays = () => mongoose.models.KbStorageDaily as Model<IKbStorageDailyDoc>;

  type VersionTotals = Pick<KbStorageFigures, 'versions' | 'originalBytes'> & {
    _id: string | null;
  };
  type DocumentTotals = Pick<
    KbStorageFigures,
    'documents' | 'indexChunks' | 'parsedBytes' | 'unmeasuredVersions'
  > & {
    _id: string | null;
    bytes: number;
  };

  /** Version totals grouped by tenant (`'$tenantId'`) or all together (`null`). */
  const sumVersions = (match: object, by: '$tenantId' | null) =>
    versions().aggregate<VersionTotals>([
      { $match: match },
      {
        $group: {
          _id: by,
          versions: { $sum: 1 },
          originalBytes: { $sum: '$sizeBytes' },
        },
      },
    ]);

  const live = { $gt: ['$currentVersion', 0] };

  /**
   * Document totals. Parsed text counts the live version only: activating a version drops every
   * other version's chunks from the search index.
   */
  const sumDocuments = (match: object, by: '$tenantId' | null) =>
    documents().aggregate<DocumentTotals>([
      { $match: match },
      {
        $group: {
          _id: by,
          documents: { $sum: 1 },
          bytes: { $sum: '$sizeBytes' },
          indexChunks: { $sum: { $cond: [live, '$chunkCount', 0] } },
          parsedBytes: { $sum: { $cond: [live, { $ifNull: ['$parsedBytes', 0] }, 0] } },
          unmeasuredVersions: {
            $sum: {
              $cond: [{ $and: [live, { $eq: [{ $ifNull: ['$parsedBytes', null] }, null] }] }, 1, 0],
            },
          },
        },
      },
    ]);

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
    const [[docs], [stored]] = await Promise.all([sumDocuments({}, null), sumVersions({}, null)]);
    return {
      documents: docs?.documents ?? 0,
      bytes: docs?.bytes ?? 0,
      versions: stored?.versions ?? 0,
      totalBytes: (stored?.originalBytes ?? 0) + (docs?.parsedBytes ?? 0),
    };
  }

  async function measureKbStorage(tenantId?: string): Promise<KbTenantStorage[]> {
    const match = tenantId ? { tenantId } : {};
    const [docs, stored] = await Promise.all([
      sumDocuments(match, '$tenantId'),
      sumVersions(match, '$tenantId'),
    ]);
    const byTenant = new Map<string, KbTenantStorage>();
    const entry = (id: string): KbTenantStorage => {
      const found = byTenant.get(id);
      if (found) {
        return found;
      }
      const empty: KbTenantStorage = {
        tenantId: id,
        documents: 0,
        versions: 0,
        originalBytes: 0,
        parsedBytes: 0,
        indexChunks: 0,
        totalBytes: 0,
        unmeasuredVersions: 0,
      };
      byTenant.set(id, empty);
      return empty;
    };
    for (const { _id, documents: count, indexChunks, parsedBytes, unmeasuredVersions } of docs) {
      Object.assign(entry(String(_id)), {
        documents: count,
        indexChunks,
        parsedBytes,
        unmeasuredVersions,
      });
    }
    for (const { _id, versions: count, originalBytes } of stored) {
      Object.assign(entry(String(_id)), { versions: count, originalBytes });
    }
    for (const row of byTenant.values()) {
      row.totalBytes = row.originalBytes + row.parsedBytes;
    }
    if (tenantId) {
      entry(tenantId);
    }
    return [...byTenant.values()];
  }

  /**
   * Each field is replaced only when this measurement is not older than the stored one, so two
   * writers racing on the same day leave the later figures. The filter is the unique key alone,
   * which lets MongoDB retry an upsert that collides with a concurrent insert.
   */
  async function saveKbStorageDaily(rows: KbStorageDailyInput[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await tenantSafeBulkWrite(
      storageDays(),
      rows.map(({ tenantId, day, ...figures }) => {
        const newer = {
          $or: [
            { $eq: [{ $type: '$measuredAt' }, 'missing'] },
            { $lte: ['$measuredAt', figures.measuredAt] },
          ],
        };
        const set = Object.fromEntries(
          Object.entries(figures).map(([field, value]) => [
            field,
            { $cond: [newer, { $literal: value }, '$' + field] },
          ]),
        );
        return { updateOne: { filter: { tenantId, day }, update: [{ $set: set }], upsert: true } };
      }),
      { ordered: false },
    );
  }

  async function listKbStorageDaily(filter: {
    fromDay: string;
    tenantId?: string;
  }): Promise<IKbStorageDaily[]> {
    const query = {
      day: { $gte: filter.fromDay },
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
    };
    return (await storageDays()
      .find(query)
      .sort({ tenantId: 1, day: 1 })
      .select('-_id -__v -createdAt -updatedAt')
      .lean()) as IKbStorageDaily[];
  }

  async function hasReadyKbDocuments(tenantId: string): Promise<boolean> {
    const found = await documents()
      .exists({ tenantId, currentVersion: { $gt: 0 } })
      .lean();
    return found != null;
  }

  async function listReadyKbCatalog(
    tenantId: string,
    limit: number = KbLimits.maxDocuments,
  ): Promise<KbCatalogEntry[]> {
    const ready = await documents()
      .find({ tenantId, currentVersion: { $gt: 0 } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select('_id title docType')
      .lean();
    return ready.map(({ _id, title, docType }) => ({ id: String(_id), title, docType }));
  }

  async function listKbDocumentIds(tenantId: string): Promise<string[]> {
    const ids = await documents().distinct('_id', { tenantId });
    return ids.map(String);
  }

  async function listKbTenantIds(): Promise<string[]> {
    const institutions = mongoose.models.Institution;
    const [fromInstitutions, fromDocuments] = await Promise.all([
      institutions ? institutions.distinct('tenantId') : Promise.resolve([]),
      documents().distinct('tenantId'),
    ]);
    return [...new Set([...fromInstitutions, ...fromDocuments].map(String))].filter(Boolean);
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

  async function renewKbIngestJob(
    jobId: Types.ObjectId | string,
    now: Date = new Date(),
  ): Promise<void> {
    await jobs().updateOne(
      { _id: jobId, status: KbIngestJobStatuses.PROCESSING },
      { $set: { lockedAt: now } },
    );
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
      ...(input.parsedBytes != null ? { parsedBytes: input.parsedBytes } : {}),
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
          parsedBytes: input.parsedBytes ?? null,
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

  async function retryKbDocument(documentId: string): Promise<IKbDocument | null> {
    const document = await documents().findOne({ _id: documentId });
    if (!document) {
      return null;
    }
    const job = await jobs().findOneAndUpdate(
      {
        documentId: document._id,
        version: document.latestVersion,
        status: KbIngestJobStatuses.FAILED,
      },
      {
        $set: {
          status: KbIngestJobStatuses.QUEUED,
          attempts: 0,
          availableAt: new Date(),
          lockedAt: null,
          error: null,
        },
      },
    );
    if (!job) {
      return null;
    }
    return (await documents()
      .findOneAndUpdate(
        { _id: document._id },
        { $set: { status: KbDocumentStatuses.QUEUED, error: null } },
        { new: true },
      )
      .lean()) as IKbDocument | null;
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
    measureKbStorage,
    saveKbStorageDaily,
    listKbStorageDaily,
    hasReadyKbDocuments,
    listReadyKbCatalog,
    listKbDocumentIds,
    listKbTenantIds,
    updateKbDocument,
    listKbDocumentVersions,
    claimKbIngestJob,
    renewKbIngestJob,
    completeKbIngestJob,
    failKbIngestJob,
    deleteKbDocument,
    retryKbDocument,
  };
}
