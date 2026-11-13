export const KbDocumentStatuses = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;

export type KbDocumentStatus = (typeof KbDocumentStatuses)[keyof typeof KbDocumentStatuses];

export const KbIngestJobStatuses = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
} as const;

export type KbIngestJobStatus = (typeof KbIngestJobStatuses)[keyof typeof KbIngestJobStatuses];

export { KbDocTypes } from 'librechat-data-provider';
export type { KbDocType } from 'librechat-data-provider';

/** One flat platform limit per institution (decision 10 in docs/institution-kb-plan.md). */
export const KbLimits = {
  maxDocuments: 200,
  /** 50 MB */
  maxFileBytes: 52_428_800,
  /** 1 GB */
  maxTotalBytes: 1_073_741_824,
  maxVersionsKept: 5,
  maxIngestAttempts: 3,
  /** A job still `processing` after this long is treated as abandoned and claimed again. */
  ingestLeaseMs: 1_800_000,
} as const;
