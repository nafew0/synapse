import type { Document, Types } from 'mongoose';

/** A short sign-in code shown on the connect page, or the token the extension holds after exchanging one. */
export type BrowserExtensionCredentialKind = 'code' | 'token';

export interface BrowserExtensionCredentialFields {
  user: Types.ObjectId;
  tenantId?: string;
  kind: BrowserExtensionCredentialKind;
  /** The SHA-256 of the code or token; the value itself is never stored. */
  hash: string;
  expiresAt: Date;
  lastUsedAt?: Date;
}

export interface IBrowserExtensionCredential extends BrowserExtensionCredentialFields, Document {
  _id: Types.ObjectId;
  createdAt?: Date;
}

/** One model call made through the extension endpoint, counted from the provider's own usage report. */
export interface BrowserExtensionUsageFields {
  user: Types.ObjectId;
  tenantId?: string;
  llmModel: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  at: Date;
}

export interface IBrowserExtensionUsage extends BrowserExtensionUsageFields, Document {
  _id: Types.ObjectId;
}
