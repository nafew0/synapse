import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import type {
  IUser,
  AuditAction,
  IInstitution,
  IUsagePackage,
  AuditMetadata,
  UsagePackageScope,
  MemberUsagePackage,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  InstitutionUsagePackage,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { buildAuditContext } from '~/admin/context';

const packageKey = z.string().trim().toLowerCase().min(1).max(40);

const institutionAssignmentSchema = z
  .object({
    packageKey: packageKey.nullable().default(null),
    memberPackageKey: packageKey.nullable().default(null),
  })
  .strict()
  .refine((value) => value.packageKey != null || value.memberPackageKey != null, {
    message: 'Set packageKey, memberPackageKey, or both; use DELETE to remove both',
  });

const memberAssignmentSchema = z
  .object({
    packageKey,
    expiresAt: z.coerce.date().nullable().default(null),
  })
  .strict();

export interface UsageAssignmentDeps {
  getUsagePackage: (key: string) => Promise<IUsagePackage | null>;
  getInstitutionByTenantId: (tenantId: string) => Promise<IInstitution | null>;
  updateInstitutionByTenantId: (
    tenantId: string,
    updates: Partial<IInstitution>,
  ) => Promise<IInstitution | null>;
  getUserById: (userId: string, fields?: string) => Promise<IUser | null>;
  updateUser: (userId: string, updates: Partial<IUser>) => Promise<IUser | null>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
}

type TenantRequest = ServerRequest & { params: { tenantId?: string } };
type UserRequest = ServerRequest & { params: { userId?: string } };
type Handler<R extends ServerRequest> = (req: R, res: Response) => Promise<Response>;

export interface UsageAssignmentHandlers {
  setInstitutionPackage: Handler<TenantRequest>;
  clearInstitutionPackage: Handler<TenantRequest>;
  setMemberPackage: Handler<UserRequest>;
  clearMemberPackage: Handler<UserRequest>;
}

class AssignmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function actorOf(req: ServerRequest): { id: string | undefined; name: string } {
  const user = req.user;
  return {
    id: user?.id ?? user?._id?.toString(),
    name: user?.name || user?.email || 'platform-superadmin',
  };
}

function sendError(res: Response, error: unknown, fallback: string): Response {
  if (error instanceof AssignmentError) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.error(`[usageAssignments] ${fallback}`, error);
  return res.status(500).json({ error: fallback });
}

/** Superadmin handlers that assign usage packages. Mount behind platform-superadmin auth. */
export function createUsageAssignmentHandlers(deps: UsageAssignmentDeps): UsageAssignmentHandlers {
  /** Only active packages meant for this kind of account can be newly assigned. */
  async function requirePackage(key: string, scope: UsagePackageScope): Promise<IUsagePackage> {
    const pkg = await deps.getUsagePackage(key);
    if (!pkg) {
      throw new AssignmentError(400, `Package "${key}" does not exist`);
    }
    if (!pkg.active) {
      throw new AssignmentError(400, `Package "${key}" is archived`);
    }
    if (!pkg.scopes.includes(scope)) {
      throw new AssignmentError(400, `Package "${key}" cannot be assigned to ${scope}s`);
    }
    return pkg;
  }

  async function audit(
    req: ServerRequest,
    action: AuditAction,
    target: { type: string; id: string; name?: string },
    metadata: AuditMetadata,
    tenantId?: string,
  ): Promise<void> {
    const actor = actorOf(req);
    await deps.recordAuditEntry(
      {
        action,
        severity: 'warning',
        actor: { type: 'user', id: actor.id, name: actor.name },
        target,
        metadata,
        context: buildAuditContext(req),
        tenantId,
      },
      { failClosed: true },
    );
  }

  async function setInstitutionPackage(req: TenantRequest, res: Response) {
    const tenantId = req.params.tenantId ?? '';
    const parsed = institutionAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.flatten() });
    }
    try {
      const { packageKey: own, memberPackageKey } = parsed.data;
      const [institution] = await Promise.all([
        deps.getInstitutionByTenantId(tenantId),
        own ? requirePackage(own, 'institution') : null,
        memberPackageKey ? requirePackage(memberPackageKey, 'member') : null,
      ]);
      if (!institution) {
        return res.status(404).json({ error: 'Institution not found' });
      }
      const usagePackage: InstitutionUsagePackage = {
        packageKey: own,
        memberPackageKey,
        assignedAt: new Date(),
        assignedBy: actorOf(req).id,
      };
      const updated = await deps.updateInstitutionByTenantId(tenantId, { usagePackage });
      await audit(
        req,
        'platform.usage_package_assigned',
        { type: 'institution', id: tenantId, name: institution.name },
        {
          packageKey: own,
          memberPackageKey,
          previous_packageKey: institution.usagePackage?.packageKey ?? null,
          previous_memberPackageKey: institution.usagePackage?.memberPackageKey ?? null,
        },
      );
      return res.json({ tenantId, usagePackage: updated?.usagePackage ?? usagePackage });
    } catch (error) {
      return sendError(res, error, 'Failed to assign the institution package');
    }
  }

  async function clearInstitutionPackage(req: TenantRequest, res: Response) {
    const tenantId = req.params.tenantId ?? '';
    try {
      const institution = await deps.getInstitutionByTenantId(tenantId);
      if (!institution) {
        return res.status(404).json({ error: 'Institution not found' });
      }
      await deps.updateInstitutionByTenantId(tenantId, { usagePackage: null });
      await audit(
        req,
        'platform.usage_package_revoked',
        { type: 'institution', id: tenantId, name: institution.name },
        {
          previous_packageKey: institution.usagePackage?.packageKey ?? null,
          previous_memberPackageKey: institution.usagePackage?.memberPackageKey ?? null,
        },
      );
      return res.json({ tenantId, usagePackage: null });
    } catch (error) {
      return sendError(res, error, 'Failed to remove the institution package');
    }
  }

  async function setMemberPackage(req: UserRequest, res: Response) {
    const userId = req.params.userId ?? '';
    const parsed = memberAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.flatten() });
    }
    try {
      const { packageKey: key, expiresAt } = parsed.data;
      if (expiresAt != null && expiresAt <= new Date()) {
        return res.status(400).json({ error: 'expiresAt must be in the future' });
      }
      const [user] = await Promise.all([
        deps.getUserById(userId, 'name email tenantId usagePackage'),
        requirePackage(key, 'member'),
      ]);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const usagePackage: MemberUsagePackage = {
        packageKey: key,
        expiresAt,
        assignedAt: new Date(),
        assignedBy: actorOf(req).id,
      };
      await deps.updateUser(userId, { usagePackage });
      await audit(
        req,
        'platform.usage_package_assigned',
        { type: 'user', id: userId, name: user.email ?? user.name },
        {
          packageKey: key,
          expiresAt: expiresAt?.toISOString() ?? null,
          previous_packageKey: user.usagePackage?.packageKey ?? null,
        },
        user.tenantId,
      );
      return res.json({ userId, usagePackage });
    } catch (error) {
      return sendError(res, error, 'Failed to assign the member package');
    }
  }

  async function clearMemberPackage(req: UserRequest, res: Response) {
    const userId = req.params.userId ?? '';
    try {
      const user = await deps.getUserById(userId, 'name email tenantId usagePackage');
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      await deps.updateUser(userId, { usagePackage: null });
      await audit(
        req,
        'platform.usage_package_revoked',
        { type: 'user', id: userId, name: user.email ?? user.name },
        { previous_packageKey: user.usagePackage?.packageKey ?? null },
        user.tenantId,
      );
      return res.json({ userId, usagePackage: null });
    } catch (error) {
      return sendError(res, error, 'Failed to remove the member package');
    }
  }

  return { setInstitutionPackage, clearInstitutionPackage, setMemberPackage, clearMemberPackage };
}
