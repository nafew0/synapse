import { Schema } from 'mongoose';
import type {
  IKbDocumentDoc,
  IKbIngestJobDoc,
  IKbStorageDailyDoc,
  IKbDocumentVersionDoc,
} from '~/types';
import { KbDocTypes, KbDocumentStatuses, KbIngestJobStatuses } from '~/common';

export const kbDocumentSchema: Schema<IKbDocumentDoc> = new Schema<IKbDocumentDoc>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    docType: { type: String, enum: KbDocTypes, default: 'other' },
    status: {
      type: String,
      enum: Object.values(KbDocumentStatuses),
      default: KbDocumentStatuses.QUEUED,
    },
    error: { type: String, default: null },
    currentVersion: { type: Number, default: 0, min: 0 },
    latestVersion: { type: Number, default: 1, min: 1 },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, default: 0, min: 0 },
    pageCount: { type: Number, default: 0, min: 0 },
    chunkCount: { type: Number, default: 0, min: 0 },
    unreadablePages: { type: [Number], default: [] },
    /** Parsed text of the current version in the search index; null when not recorded. */
    parsedBytes: { type: Number, default: null, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

kbDocumentSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
kbDocumentSchema.index({ tenantId: 1, docType: 1 });

export const kbDocumentVersionSchema: Schema<IKbDocumentVersionDoc> =
  new Schema<IKbDocumentVersionDoc>(
    {
      tenantId: { type: String, required: true, trim: true, index: true },
      documentId: { type: Schema.Types.ObjectId, ref: 'KbDocument', required: true },
      version: { type: Number, required: true, min: 1 },
      fileRef: { type: String, required: true },
      filename: { type: String, required: true },
      mimeType: { type: String, required: true },
      sha256: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 },
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      indexedAt: { type: Date, default: null },
      parser: {
        type: new Schema({ name: String, version: String }, { _id: false }),
        default: null,
      },
      pageCount: { type: Number, default: 0 },
      chunkCount: { type: Number, default: 0 },
      parsedBytes: { type: Number, default: null, min: 0 },
    },
    { timestamps: true },
  );

kbDocumentVersionSchema.index({ documentId: 1, version: -1 }, { unique: true });

export const kbIngestJobSchema: Schema<IKbIngestJobDoc> = new Schema<IKbIngestJobDoc>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'KbDocument', required: true },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(KbIngestJobStatuses),
      default: KbIngestJobStatuses.QUEUED,
    },
    attempts: { type: Number, default: 0, min: 0 },
    availableAt: { type: Date, default: () => new Date() },
    lockedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

kbIngestJobSchema.index({ status: 1, availableAt: 1 });
kbIngestJobSchema.index({ documentId: 1, version: 1 }, { unique: true });

const storageFigure = { type: Number, required: true, min: 0, default: 0 };

/**
 * One row per tenant and Asia/Dhaka day. Rewritten whenever the knowledge base changes and by the
 * daily job, so a day keeps its latest measurement; never incremented.
 */
export const kbStorageDailySchema: Schema<IKbStorageDailyDoc> = new Schema<IKbStorageDailyDoc>(
  {
    tenantId: { type: String, required: true, trim: true },
    day: { type: String, required: true },
    documents: storageFigure,
    versions: storageFigure,
    originalBytes: storageFigure,
    parsedBytes: storageFigure,
    indexChunks: storageFigure,
    totalBytes: storageFigure,
    unmeasuredVersions: storageFigure,
    measuredAt: { type: Date, required: true },
  },
  { timestamps: true },
);

kbStorageDailySchema.index({ tenantId: 1, day: 1 }, { unique: true });
kbStorageDailySchema.index({ day: 1 });
