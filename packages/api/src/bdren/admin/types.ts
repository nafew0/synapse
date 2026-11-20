import type { Request } from 'express';

/** Who is acting and for which institution; set only by the guard (or the upload ticket). */
export interface AdminActor {
  userId: string;
  subject: string;
  issuer: string;
  name?: string;
  email?: string;
}

export interface AdminContext {
  tenantId: string;
  organizationId: string;
  institutionName: string;
  actor: AdminActor;
}

export type AdminRequest = Request & {
  bdren?: AdminContext;
  user?: { id: string };
};

export type AuditWriter = (entry: {
  action: string;
  actor: { type: 'api'; id: string; name: string };
  target: { type: string; id?: string; name?: string };
  metadata?: Record<string, string | number | boolean | null>;
  outcome?: 'success' | 'failure' | 'denied';
  context?: { ip?: string; userAgent?: string; requestId?: string };
  tenantId: string;
}) => Promise<unknown>;
