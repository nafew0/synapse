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

export type MemberMoveStatus = 'running' | 'done' | 'refused' | 'redirected';

/** A moving item renamed because its name is taken in the target tenant. */
export interface MemberMoveRename {
  model: 'MCPServer' | 'Skill';
  id: string;
  from: string;
  to: string;
}

/**
 * What a move decided before touching anything, so a resumed move applies the same split. On a
 * leave, items the person shared in the institution stay there (`kept*`); the rest moves.
 */
export interface MemberMovePlan {
  /** Agents (`_id`) shared in the institution: they stay, as do their files and actions. */
  keptAgents: string[];
  /** Prompt groups (`_id`) that stay: shared ones, and colleagues' groups the person wrote prompts in. */
  keptPromptGroups: string[];
  keptMcpServers: string[];
  keptSkills: string[];
  /** The person's `file_id`s an agent staying in the institution uses (any author). */
  keptFiles: string[];
  /** The `id` of every agent that moves, so its actions move with it. */
  movedAgentIds: string[];
  /** The `_id` of every skill that moves, so its files move with it. */
  movedSkills: string[];
  /**
   * Who owns what stays in the institution once the person has left: an active institution
   * admin, or (none) the institution's own id, which is nobody's account. `null` on a join.
   */
  heir?: string | null;
  /** Whether `heir` is a user, who then also gets the person's grants on what stays. */
  heirIsUser?: boolean;
  renames?: MemberMoveRename[];
}

/**
 * One move of a person between tenants (`null`: no tenant, an individual), as a resumable job. At
 * most one is running per user; the lease says who is working on it. `completed` lists the steps
 * already applied, `moved` how many records each step changed.
 */
export interface IMemberMove {
  userId: Types.ObjectId;
  from: string | null;
  to: string | null;
  reason: string;
  status: MemberMoveStatus;
  mode?: 'transaction' | 'sequential' | null;
  leaseId?: string | null;
  leaseUntil?: Date | null;
  plan?: MemberMovePlan | null;
  completed: string[];
  moved: Record<string, number>;
  conflicts: Record<string, number>;
  seatReserved?: boolean;
  seatReleased?: boolean;
  userSwitched?: boolean;
  wasActive?: boolean;
  refusal?: string | null;
  /** Grants on moved items to principals outside the target tenant, dropped: `type:id:principalType:principalId`. */
  droppedGrants?: string[];
  /** When the second sweep for writes that were in flight during the move is due, and when it ran. */
  lateSweepAt?: Date | null;
  lateSweptAt?: Date | null;
  finishedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}
