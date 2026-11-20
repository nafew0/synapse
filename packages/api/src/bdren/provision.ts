import mongoose from 'mongoose';
import { logger, runAsSystem, InstitutionStatuses } from '@librechat/data-schemas';
import type {
  IUser,
  IInstitution,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { AllowanceService } from './allowance';
import type { AllowanceClient, AllowanceIdentity } from './client';
import type { BdrenConfig } from './types';
import type { IdentityUser } from './identity';
import { allowanceSubjectFor } from './identity';
import { syncAlerts } from '~/admin/alerts/store';
import { normalizeOpenIdIssuer } from '~/auth/openid';

/** The bdren.ai organization an institution is created for. */
export interface OrganizationRef {
  id: string;
  slug?: string | null;
  name?: string | null;
}

export interface ProvisionDeps {
  config: BdrenConfig;
  client: AllowanceClient;
  service: AllowanceService;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
  /** Seeds what a new tenant needs before anyone is appointed in it (tenant roles). Idempotent. */
  onCreated?: (tenantId: string) => Promise<void>;
  /**
   * Puts an existing, tenantless user into a tenant as an active member (seat limit enforced) and
   * returns them, or undoes everything and returns `null`.
   */
  placeMember: (userId: string, tenantId: string) => Promise<MemberRecord | null>;
}

/** A user as the login carries on with it after placement. */
export type MemberRecord = Record<string, unknown> & { tenantId?: string };

export interface Provisioner {
  /**
   * The tenant of a bdren.ai organization, created when Synapse does not know it yet; `null` when
   * it must not be created because an institution made by hand already holds the slug (a slug is
   * not proof it is the same one): that is recorded for a superadmin to link. An existing link is
   * reused, and the unique `bdrenOrganizationId` index makes concurrent calls create one row.
   */
  ensureInstitutionForOrganization: (org: OrganizationRef) => Promise<string | null>;
  /**
   * The tenant a brand-new SSO user belongs in, from bdren.ai's answer for them (`idToken` lets
   * bdren.ai learn a person who has never signed in there), or `null` when they are not covered by
   * an institution, it is closed or full, bdren.ai cannot be reached, or the link is off.
   * Never throws: login must not depend on bdren.ai.
   */
  tenantForNewMember: (identity: AllowanceIdentity) => Promise<string | null>;
  /**
   * Places a user just created without a tenant. When that fails, for any reason, they stay
   * without one, the reason is recorded, and `null` is returned. Never throws.
   */
  adoptNewMember: (userId: string, tenantId: string) => Promise<MemberRecord | null>;
  /**
   * For an existing user covered by an institution that is not their tenant. Never creates an
   * institution. A tenantless user with no chats yet is placed (a brief bdren.ai failure at
   * first login must not leave them out for good); anyone else is never moved, and the mismatch
   * is recorded once for a superadmin. Never throws.
   */
  reviewExistingMember: (
    user: IdentityUser & { bdrenNotedOrganizationId?: string },
    options?: { idToken?: string },
  ) => Promise<void>;
}

const DUPLICATE_KEY = 11000;
const MAX_TENANT_ID_LENGTH = 40;
const MAX_ATTEMPTS = 6;
const SERVICE_ACTOR = { type: 'service', name: 'bdren.ai' } as const;

const conversations = (): Model<{ user: string }> =>
  mongoose.models.Conversation as Model<{ user: string }>;
const messages = (): Model<{ user: string }> => mongoose.models.Message as Model<{ user: string }>;
const users = (): Model<IUser> => mongoose.models.User as Model<IUser>;
const institutions = (): Model<IInstitution> => mongoose.models.Institution as Model<IInstitution>;

/** Lowercase letters, digits and single hyphens; never starts with the reserved `__`. */
export function tenantIdFromSlug(slug: string | null | undefined): string {
  const cleaned = (slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TENANT_ID_LENGTH)
    .replace(/-+$/g, '');
  return cleaned || 'institution';
}

function suffixFor(org: OrganizationRef, attempt: number): string {
  const alnum = org.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (attempt === 1 && alnum) {
    return alnum.slice(-6);
  }
  return `${alnum.slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}

function candidateFor(org: OrganizationRef, attempt: number): string {
  const base = tenantIdFromSlug(org.slug ?? org.name);
  return attempt === 0
    ? base
    : `${base.slice(0, MAX_TENANT_ID_LENGTH - 7)}-${suffixFor(org, attempt)}`;
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: number })?.code === DUPLICATE_KEY;
}

function findByOrganization(organizationId: string): Promise<IInstitution | null> {
  return runAsSystem(() =>
    institutions().findOne({ bdrenOrganizationId: organizationId }).lean<IInstitution>().exec(),
  );
}

interface Ensured {
  institution: IInstitution;
  created: boolean;
}

/** Whether a member may still be added; seats beyond a hand-set cap are Synapse's, bdren.ai's seats are not enforced here. */
export function hasCapacity(institution: IInstitution): boolean {
  const max = institution.limits?.maxActiveMembers;
  return max == null || (institution.stats?.activeMembers ?? 0) < max;
}

export function createProvisioner(deps: ProvisionDeps): Provisioner {
  const { config, client, service, recordAuditEntry, onCreated, placeMember } = deps;

  async function audit(input: RecordAuditEntryInput): Promise<void> {
    try {
      await recordAuditEntry(input);
    } catch (error) {
      logger.error('[bdren] provisioning audit entry failed', error);
    }
  }

  /** An institution not linked to any organization that already holds the name this one would get. */
  function findUnlinkedHolder(org: OrganizationRef): Promise<IInstitution | null> {
    const base = tenantIdFromSlug(org.slug ?? org.name);
    return runAsSystem(() =>
      institutions()
        .findOne({
          $or: [{ tenantId: base }, { slug: base }],
          bdrenOrganizationId: { $not: { $type: 'string' } },
        })
        .lean<IInstitution>()
        .exec(),
    );
  }

  async function needsLink(org: OrganizationRef, unlinked: IInstitution): Promise<void> {
    const { raised } = await syncAlerts(
      [
        {
          key: `institution_link:${org.id}`,
          kind: 'institution_link',
          severity: 'warning',
          title: `Link ${unlinked.name} to its bdren.ai organization`,
          detail: `bdren.ai organization ${org.slug ?? org.id} (${org.id}) looks like the institution ${unlinked.tenantId}. Map it in the institution settings.`,
        },
      ],
      [],
    );
    if (raised === 0) {
      return;
    }
    logger.warn(
      `[bdren] organization ${org.id} matches the unlinked institution ${unlinked.tenantId}; not created`,
    );
    await audit({
      action: 'institution.link_needed',
      actor: SERVICE_ACTOR,
      target: { type: 'institution', id: unlinked.tenantId, name: unlinked.name },
      metadata: {
        organizationId: org.id,
        organizationSlug: org.slug ?? null,
        organizationName: org.name ?? null,
        unlinkedTenantId: unlinked.tenantId,
      },
    });
  }

  async function create(org: OrganizationRef): Promise<Ensured> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tenantId = candidateFor(org, attempt);
      try {
        const doc = await runAsSystem(() =>
          institutions().create({
            tenantId,
            slug: tenantId,
            name: (org.name || org.slug || tenantId).trim(),
            bdrenOrganizationId: org.id,
            status: InstitutionStatuses.ACTIVE,
            authDomains: [],
            stats: { activeMembers: 0 },
          }),
        );
        return { institution: doc.toObject() as IInstitution, created: true };
      } catch (error) {
        if (!isDuplicate(error)) {
          throw error;
        }
        const winner = await findByOrganization(org.id);
        if (winner) {
          return { institution: winner, created: false };
        }
      }
    }
    throw new Error(`no free tenant id for organization ${org.id}`);
  }

  async function announce(institution: IInstitution, org: OrganizationRef): Promise<void> {
    await audit({
      action: 'institution.provisioned',
      actor: SERVICE_ACTOR,
      target: { type: 'institution', id: institution.tenantId, name: institution.name },
      metadata: {
        organizationId: org.id,
        organizationSlug: org.slug ?? null,
        source: 'bdren.ai',
      },
    });
    try {
      await onCreated?.(institution.tenantId);
    } catch (error) {
      logger.error(`[bdren] seeding tenant ${institution.tenantId} failed`, error);
    }
    logger.info(`[bdren] created institution ${institution.tenantId} for organization ${org.id}`);
  }

  async function ensureInstitution(org: OrganizationRef): Promise<IInstitution | null> {
    const existing = await findByOrganization(org.id);
    if (existing) {
      return existing;
    }
    const unlinked = await findUnlinkedHolder(org);
    if (unlinked) {
      await needsLink(org, unlinked);
      return null;
    }
    const { institution, created } = await create(org);
    if (created) {
      await announce(institution, org);
    }
    return institution;
  }

  async function tenantForNewMember(identity: AllowanceIdentity): Promise<string | null> {
    if (
      !config.enabled ||
      normalizeOpenIdIssuer(identity.issuer) !== normalizeOpenIdIssuer(config.issuer)
    ) {
      return null;
    }
    try {
      const answer = await client.fetchAllowance(identity);
      if (answer.status !== 'ok') {
        return null;
      }
      const { plan_source: source, institution: org } = answer.payload;
      if (source !== 'institution' || !org) {
        return null;
      }
      const institution = await ensureInstitution(org);
      if (!institution) {
        return null;
      }
      if (institution.status === InstitutionStatuses.CLOSED) {
        logger.warn(`[bdren] institution ${institution.tenantId} is closed; new member not placed`);
        return null;
      }
      if (!hasCapacity(institution)) {
        logger.warn(`[bdren] institution ${institution.tenantId} is full; new member not placed`);
        return null;
      }
      return institution.tenantId;
    } catch (error) {
      logger.error('[bdren] could not place a new SSO user in an institution', error);
      return null;
    }
  }

  async function noteMismatch(
    userId: string,
    organizationId: string,
    details: { institutionTenantId: string | null; currentTenantId: string | null; reason: string },
  ): Promise<void> {
    logger.warn(
      `[bdren] user ${userId} is covered by organization ${organizationId} (${details.reason}) but belongs to ${details.currentTenantId ?? 'no institution'}; not moved`,
    );
    await audit({
      action: 'member.coverage_mismatch',
      actor: SERVICE_ACTOR,
      target: { type: 'user', id: userId },
      metadata: { organizationId, ...details },
      tenantId: undefined,
    });
    await runAsSystem(() =>
      users()
        .updateOne({ _id: userId }, { $set: { bdrenNotedOrganizationId: organizationId } })
        .exec(),
    );
  }

  async function adoptNewMember(userId: string, tenantId: string): Promise<MemberRecord | null> {
    try {
      const placed = await placeMember(userId, tenantId);
      if (placed) {
        return placed;
      }
    } catch (error) {
      logger.error(`[bdren] placing user ${userId} in ${tenantId} failed`, error);
    }
    const institution = await runAsSystem(() =>
      institutions()
        .findOne({ tenantId })
        .select('bdrenOrganizationId')
        .lean<IInstitution>()
        .exec(),
    );
    await noteMismatch(userId, institution?.bdrenOrganizationId ?? tenantId, {
      institutionTenantId: tenantId,
      currentTenantId: null,
      reason: 'placement_failed',
    }).catch((error) => logger.error('[bdren] recording the failed placement failed', error));
    return null;
  }

  async function hasChats(userId: string): Promise<boolean> {
    const [conversation, message] = await runAsSystem(() =>
      Promise.all([
        conversations().exists({ user: userId }).exec(),
        messages().exists({ user: userId }).exec(),
      ]),
    );
    return conversation != null || message != null;
  }

  async function reviewExistingMember(
    user: IdentityUser & { bdrenNotedOrganizationId?: string },
    options: { idToken?: string } = {},
  ): Promise<void> {
    try {
      /** A tenantless SSO user may carry no account scope yet; only the identity matters for a lookup. */
      const who = allowanceSubjectFor(
        { ...user, accountScope: user.tenantId ? user.accountScope : 'standalone' },
        config,
      );
      if (!who) {
        return;
      }
      const allowance = await service.getAllowance({ ...who, idToken: options.idToken });
      const organizationId = allowance.institutionId;
      if (allowance.planSource !== 'institution' || !organizationId) {
        return;
      }
      const institution = await findByOrganization(organizationId);
      if (institution && user.tenantId === institution.tenantId) {
        return;
      }
      const placeable =
        institution != null &&
        !user.tenantId &&
        institution.status === InstitutionStatuses.ACTIVE &&
        hasCapacity(institution) &&
        !(await hasChats(who.userId));
      if (placeable && (await placeMember(who.userId, institution.tenantId))) {
        logger.info(
          `[bdren] placed user ${who.userId} in ${institution.tenantId} on a later login`,
        );
        return;
      }
      if (user.bdrenNotedOrganizationId === organizationId) {
        return;
      }
      await noteMismatch(who.userId, organizationId, {
        institutionTenantId: institution?.tenantId ?? null,
        currentTenantId: user.tenantId ?? null,
        reason: institution ? 'not_moved' : 'institution_not_linked',
      });
    } catch (error) {
      logger.error('[bdren] membership review failed', error);
    }
  }

  return {
    ensureInstitutionForOrganization: async (org) =>
      (await ensureInstitution(org))?.tenantId ?? null,
    tenantForNewMember,
    adoptNewMember,
    reviewExistingMember,
  };
}
