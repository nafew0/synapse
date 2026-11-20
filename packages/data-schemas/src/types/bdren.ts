import type { Types } from 'mongoose';

/** The allowance bdren.ai returned for one person, as fetched. */
export interface BdrenAllowanceWindow {
  start: string;
  end: string | null;
}

export interface BdrenAllowancePayload {
  product: string;
  user: { subject: string; email?: string };
  plan_source: 'free' | 'personal' | 'institution';
  package: { slug: string; name: string; version: number } | null;
  institution?: {
    id: string;
    slug?: string;
    name?: string;
    seats?: number | null;
    seat_level?: string | null;
  } | null;
  subscription: {
    id: string;
    status: string;
    starts_at: string;
    expires_at: string | null;
  } | null;
  limits: Record<string, Record<string, number>>;
  limits_source?: string;
  windows: Record<string, BdrenAllowanceWindow>;
  renews?: string;
  upgrade_url?: string;
  etag: string;
}

/** Cached allowance of one user. Platform-level: `tenantId` is the quota account, not an isolation scope. */
export interface IBdrenAllowance {
  userId: Types.ObjectId;
  tenantId: string;
  issuer: string;
  subject: string;
  etag: string;
  allowance: BdrenAllowancePayload;
  fetchedAt: Date;
  /** Last time bdren.ai confirmed this answer (200 or 304). The 24-hour safety rule counts from here. */
  verifiedAt: Date;
  /** Set by a webhook: the entry must be refetched before it is used again. */
  invalidatedAt?: Date | null;
  /** The windows of the answer this one replaced, kept so an upgrade can still find the old period. */
  previousWindows?: Record<string, BdrenAllowanceWindow> | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A webhook event already handled, so a redelivery does nothing twice. */
export interface IBdrenEvent {
  eventId: string;
  type: string;
  receivedAt: Date;
}

/**
 * A one-file upload ticket for the institution knowledge base. The signed URL names the ticket;
 * the ticket fixes the tenant, the acting admin, the file name and size, and is spent on first use.
 */
export interface IBdrenUploadTicket {
  ticketId: string;
  tenantId: string;
  organizationId: string;
  actorUserId: string;
  actorSubject: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  title?: string;
  docType?: string;
  /** Set when the upload adds a version to an existing document instead of creating one. */
  documentId?: string;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt?: Date;
}
