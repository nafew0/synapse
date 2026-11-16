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

/** One step of a run as a report carries it: what the agent did and how it went, never what the page showed. */
export interface BrowserExtensionReportStep {
  tool: string;
  /** The call's arguments with typed text, values and file contents replaced by their length. */
  args: string;
  ok: boolean;
  /** The error code of a failed step. */
  code?: string;
}

/** A run the user chose to send from the extension, so a failure can be studied without their screen. */
export interface BrowserExtensionReportFields {
  user: Types.ObjectId;
  tenantId?: string;
  extensionVersion: string;
  build?: string;
  llmModel?: string;
  status: string;
  outcome?: string;
  reason?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** The sites the run visited, by host only. */
  hosts: string[];
  /** What the user says went wrong, in their words. */
  comment?: string;
  steps: BrowserExtensionReportStep[];
  createdAt: Date;
}

export interface IBrowserExtensionReport extends BrowserExtensionReportFields, Document {
  _id: Types.ObjectId;
}
