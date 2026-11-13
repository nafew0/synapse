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
export type IKbIngestJobDoc = Omit<IKbIngestJob, '_id'> & Document<Types.ObjectId>;
