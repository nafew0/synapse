import type { Document, Types } from 'mongoose';
import type { KbDocType, KbDocumentStatus, KbIngestJobStatus } from '~/common';

export interface KbParserInfo {
  name: string;
  version: string;
}

export interface IKbDocument {
  _id: Types.ObjectId;
  tenantId: string;
  title: string;
  docType: KbDocType;
  status: KbDocumentStatus;
  error?: string | null;
  /** The version searches read; 0 until the first version is indexed. */
  currentVersion: number;
  latestVersion: number;
  filename: string;
  mimeType: string;
  /** Size of the current version, which is what counts toward the storage limit. */
  sizeBytes: number;
  pageCount: number;
  chunkCount: number;
  unreadablePages: number[];
  /** Parsed text bytes of the current version in the search index; null when not recorded. */
  parsedBytes?: number | null;
  createdBy?: Types.ObjectId | string | null;
  updatedBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IKbDocumentVersion {
  _id: Types.ObjectId;
  tenantId: string;
  documentId: Types.ObjectId;
  version: number;
  fileRef: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  uploadedBy?: Types.ObjectId | string | null;
  indexedAt?: Date | null;
  parser?: KbParserInfo | null;
  pageCount?: number;
  chunkCount?: number;
  /**
   * UTF-8 bytes of the parsed text this version sent to the search index (chunk text plus the
   * text that was embedded), measured when it was indexed. Null for versions indexed before it
   * was recorded, and for versions not indexed yet.
   */
  parsedBytes?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** What a tenant's knowledge base takes up, from the sizes recorded at write time. */
export interface KbStorageFigures {
  /** Document records, in any state. */
  documents: number;
  /** Stored versions: the live one plus the older ones kept for history. */
  versions: number;
  /** Original files on disk, every stored version. */
  originalBytes: number;
  /** Parsed text in the search index: the live versions only, the index keeps no other. */
  parsedBytes: number;
  /** Search index chunks of the live versions. */
  indexChunks: number;
  /** `originalBytes + parsedBytes`. */
  totalBytes: number;
  /** Live versions whose parsed size was never recorded (indexed before it was). */
  unmeasuredVersions: number;
}

/** One tenant's knowledge base storage on one Asia/Dhaka day; the day's last measurement wins. */
export interface IKbStorageDaily extends KbStorageFigures {
  tenantId: string;
  /** Asia/Dhaka calendar day, `YYYY-MM-DD`. */
  day: string;
  measuredAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IKbIngestJob {
  _id: Types.ObjectId;
  tenantId: string;
  documentId: Types.ObjectId;
  version: number;
  status: KbIngestJobStatus;
  attempts: number;
  availableAt: Date;
  lockedAt?: Date | null;
  error?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IKbDocumentDoc = Omit<IKbDocument, '_id'> & Document<Types.ObjectId>;
export type IKbDocumentVersionDoc = Omit<IKbDocumentVersion, '_id'> & Document<Types.ObjectId>;
export type IKbStorageDailyDoc = IKbStorageDaily & Document<Types.ObjectId>;
export type IKbIngestJobDoc = Omit<IKbIngestJob, '_id'> & Document<Types.ObjectId>;
