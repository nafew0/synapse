import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AdminRequest, AuditWriter } from './types';

type Metadata = Record<string, string | number | boolean | null>;

/**
 * Records a write by the acting admin in the institution's audit log. Written after the response,
 * as the admin identity (issuer + subject), the organization and the Synapse user id. A failed audit
 * write is logged loudly but never undoes a change that already happened.
 */
export function createAuditor(write: AuditWriter) {
  return async function audit(
    req: AdminRequest,
    action: string,
    target: { type: string; id?: string; name?: string },
    metadata: Metadata = {},
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> {
    const context = req.bdren;
    if (!context) {
      return;
    }
    const { actor } = context;
    try {
      await write({
        action,
        actor: { type: 'api', id: actor.userId, name: `bdren:${actor.issuer}#${actor.subject}` },
        target,
        metadata: { organizationId: context.organizationId, ...metadata },
        outcome,
        context: {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: String(req.headers['x-request-id'] ?? '') || undefined,
        },
        tenantId: context.tenantId,
      });
    } catch (error) {
      logger.error(`[bdren/admin] audit write failed for ${action}`, error);
    }
  };
}

export type Auditor = ReturnType<typeof createAuditor>;

/** Runs a handler that answers itself, then audits it by the status it sent. */
export function withAudit(
  audit: Auditor,
  action: string,
  describe: (req: AdminRequest) => {
    target: { type: string; id?: string; name?: string };
    metadata?: Metadata;
  },
  handler: (req: AdminRequest, res: Response) => Promise<unknown>,
) {
  return async (req: AdminRequest, res: Response): Promise<void> => {
    await handler(req, res);
    const { target, metadata } = describe(req);
    await audit(
      req,
      action,
      target,
      { status: res.statusCode, ...metadata },
      res.statusCode < 400 ? 'success' : 'failure',
    );
  };
}
