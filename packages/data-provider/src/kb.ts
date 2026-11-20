/** Kinds of document an institution knowledge base holds. */
export const KbDocTypes = [
  'policy',
  'circular',
  'notice',
  'form',
  'template',
  'handbook',
  'directory',
  'report',
  'other',
] as const;

export type KbDocType = (typeof KbDocTypes)[number];

export type KbDocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** A knowledge base document as the admin API returns it. */
export interface TKbDocument {
  id: string;
  title: string;
  docType: KbDocType;
  status: KbDocumentStatus;
  error: string | null;
  currentVersion: number;
  latestVersion: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  chunkCount: number;
  unreadablePages: number[];
  createdAt?: string;
  updatedAt?: string;
}

export interface TKbListResponse {
  documents: TKbDocument[];
  usage: { documents: number; bytes: number };
  limits: { maxDocuments: number; maxFileBytes: number; maxTotalBytes: number };
  extensions: string[];
  docTypes: KbDocType[];
}

export interface TKbVersion {
  version: number;
  filename: string;
  sizeBytes: number;
  indexedAt: string | null;
  current: boolean;
  createdAt?: string;
}
