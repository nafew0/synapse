import mongoose from 'mongoose';
import { InstitutionMembershipStatuses, logger, runAsSystem } from '@librechat/data-schemas';
import type { IInstitution, IUser } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { Model } from 'mongoose';
import type { AdminActor, AdminRequest } from './types';
import { normalizeOpenIdIssuer } from '~/auth/openid';

const ORGANIZATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_SUBJECT_LENGTH = 255;

const firstHeader = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : (value ?? '')).trim();

export type ActorUser = Pick<
  IUser,
  'tenantId' | 'openidId' | 'membershipStatus' | 'name' | 'email'
> & {
  _id: { toString: () => string };
};

/** The mapped institution of a bdren.ai organization. Read as the system, filtered by the id. */
export async function findInstitutionByOrganization(
  organizationId: string,
): Promise<Pick<IInstitution, 'tenantId' | 'name' | 'status'> | null> {
  return runAsSystem(() =>
    (mongoose.models.Institution as Model<IInstitution>)
      .findOne({ bdrenOrganizationId: organizationId })
      .select('tenantId name status')
      .lean<Pick<IInstitution, 'tenantId' | 'name' | 'status'>>()
      .exec(),
  );
}

/**
 * The person behind a bdren.ai identity, only if they belong to this tenant and are not removed or
 * suspended. The tenant is part of the filter, so a subject that exists elsewhere never matches.
 */
export async function findActorInTenant(
  tenantId: string,
  issuer: string,
  subject: string,
): Promise<ActorUser | null> {
  const user = await runAsSystem(() =>
    (mongoose.models.User as Model<IUser>)
      .findOne({ tenantId, openidId: subject, openidIssuer: issuer })
      .select('tenantId openidId membershipStatus name email')
      .lean<ActorUser>()
      .exec(),
  );
  const status = user?.membershipStatus;
  const active = status == null || status === InstitutionMembershipStatuses.ACTIVE;
  return user && user.tenantId === tenantId && active ? user : null;
}

export interface GuardOptions {
  /** The issuer bdren.ai signs users in with (`BDREN_ISSUER`); read per request. */
  getIssuer: () => string | undefined;
}

/**
 * Resolves the tenant of `/institutions/:orgId/...` and the acting admin. Runs after the product key
 * check. The tenant comes only from the organization mapping; the acting subject must be a live member
 * of that very tenant, so a forged or mismatched organization id reaches nothing.
 * 400 bad id or subject, 404 organization not mapped, 403 subject not in the tenant or tenant not active
 * (writes only), 503 issuer not configured.
 */
export function createInstitutionGuard({ getIssuer }: GuardOptions) {
  return async (req: AdminRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const issuer = normalizeOpenIdIssuer(getIssuer());
      if (!issuer) {
        res.status(503).json({ error: 'bdren.ai issuer is not configured' });
        return;
      }
      const organizationId = String(req.params.orgId ?? '');
      if (!ORGANIZATION_ID.test(organizationId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return;
      }
      const subject = firstHeader(req.headers['x-acting-subject']);
      if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
        res.status(400).json({ error: 'X-Acting-Subject is required' });
        return;
      }
      const claimedIssuer = normalizeOpenIdIssuer(firstHeader(req.headers['x-acting-issuer']));
      if (claimedIssuer && claimedIssuer !== issuer) {
        res.status(403).json({ error: 'Acting issuer is not accepted' });
        return;
      }
      const institution = await findInstitutionByOrganization(organizationId);
      if (!institution) {
        res.status(404).json({ error: 'Organization is not linked to an institution' });
        return;
      }
      const user = await findActorInTenant(institution.tenantId, issuer, subject);
      if (!user) {
        res.status(403).json({ error: 'The acting user is not a member of this institution' });
        return;
      }
      const readOnly = req.method === 'GET' || req.method === 'HEAD';
      if (!readOnly && institution.status && institution.status !== 'active') {
        res.status(403).json({ error: 'The institution is not active' });
        return;
      }
      const actor: AdminActor = {
        userId: user._id.toString(),
        subject,
        issuer,
        name: user.name,
        email: user.email,
      };
      req.bdren = {
        tenantId: institution.tenantId,
        organizationId,
        institutionName: institution.name,
        actor,
      };
      req.user = { id: actor.userId };
      next();
    } catch (error) {
      logger.error('[bdren/admin] guard failed', error);
      res.status(500).json({ error: 'Institution lookup failed' });
    }
  };
}
