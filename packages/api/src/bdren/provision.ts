import mongoose from 'mongoose';
import { logger, runAsSystem, InstitutionStatuses } from '@librechat/data-schemas';
import type {
  IUser,
  IInstitution,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { MemberPlacer, MemberRecord, Placement } from './place';
import type { AllowanceClient, AllowanceIdentity } from './client';
import type { BdrenConfig, ResolvedAllowance } from './types';
import type { MemberMover, MoveOutcome } from './move';
import type { AllowanceService } from './allowance';
import type { IdentityUser } from './identity';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { allowanceSubjectFor } from './identity';
import { syncAlerts } from '~/admin/alerts/store';
import { isPlatformStaff } from './move';

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
  /** Moves a tenantless user into a tenant (see `createMemberPlacer`). */
  place: MemberPlacer;
  /** Moves an existing person, with their data, between tenants (see `createMemberMover`). */
  mover: MemberMover;
}

/** An existing user as the review needs them. */
export type ReviewedUser = IdentityUser & {
  email?: string;
  role?: string;
  bdrenNotedOrganizationId?: string;
  /** Set by the SSO migration: the institution kept until bdren.ai covers the person there. */
  bdrenHoldTenantId?: string;
};

export interface ReviewOptions {
  /** The login's ID token, passed on to bdren.ai; bypasses the cached answer. */
  idToken?: string;
  /** Ask bdren.ai now, ignoring the cache (a webhook said the answer changed). */
  fresh?: boolean;
}

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
  adoptNewMember: (userId: string, tenantId: string) => Promise<Placement>;
  /**
   * Brings an existing user's institution in line with bdren.ai's coverage, moving their data
   * with them: an individual covered by a linked institution joins it; a member of a linked
   * institution no longer covered by it leaves (to the institution now covering them, or back to
   * being an individual). Never acts on a Free fallback or a stale answer, never touches platform
   * staff, users of another issuer or members of institutions not linked to bdren.ai, and never
   * creates an institution. Refusals are recorded once as `member.coverage_mismatch`. Resolves to
   * the user after a move, else `null`. Never throws.
   */
  reviewExistingMember: (
    user: ReviewedUser,
    options?: ReviewOptions,
  ) => Promise<MemberRecord | null>;
}

const DUPLICATE_KEY = 11000;
/** Answers good enough to move someone on: never the Free fallback or an answer kept while bdren.ai is down. */
const TRUSTED_ORIGINS = new Set<ResolvedAllowance['origin']>(['fresh', 'cache']);
const MAX_TENANT_ID_LENGTH = 40;
const MAX_ATTEMPTS = 6;
const SERVICE_ACTOR = { type: 'service', name: 'bdren.ai' } as const;

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

type LinkedInstitution = IInstitution & { bdrenOrganizationId: string };

function isLinked(institution: IInstitution | null): institution is LinkedInstitution {
  return typeof institution?.bdrenOrganizationId === 'string';
}

function moveReason(from: string | null, to: string | null): string {
  if (from && to) {
    return 'coverage_changed';
  }
  return to ? 'coverage_joined' : 'coverage_left';
}

export function createProvisioner(deps: ProvisionDeps): Provisioner {
  const { config, client, service, recordAuditEntry, onCreated, place, mover } = deps;

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
    noted?: string,
  ): Promise<void> {
    if (noted === `${details.reason}:${organizationId}`) {
      return;
    }
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
        .updateOne(
          { _id: userId },
          { $set: { bdrenNotedOrganizationId: `${details.reason}:${organizationId}` } },
        )
        .exec(),
    );
  }

  async function adoptNewMember(userId: string, tenantId: string): Promise<Placement> {
    try {
      const placement = await place(userId, tenantId, { replaceDuplicate: true });
      if (placement.status !== 'refused') {
        return placement;
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
    return { status: 'refused' };
  }

  /** Ends a migrated member's hold on `tenantId` once bdren.ai covers them there. */
  async function releaseHold(userId: string, tenantId: string): Promise<void> {
    await runAsSystem(() =>
      users()
        .updateOne(
          { _id: userId, bdrenHoldTenantId: tenantId },
          { $unset: { bdrenHoldTenantId: 1 } },
        )
        .exec(),
    );
  }

  /** The user's institution when it is linked to a bdren.ai organization; `undefined` for an unlinked (legacy) one. */
  async function linkedInstitutionOf(tenantId: string): Promise<LinkedInstitution | undefined> {
    const institution = await runAsSystem(() =>
      institutions().findOne({ tenantId }).lean<IInstitution>().exec(),
    );
    return isLinked(institution) ? institution : undefined;
  }

  /** Why a covered person cannot join their institution, or `null` when they can. */
  function joinRefusal(institution: IInstitution | null): string | null {
    if (!institution) {
      return 'institution_not_linked';
    }
    if (institution.status !== InstitutionStatuses.ACTIVE) {
      return 'institution_closed';
    }
    return hasCapacity(institution) ? null : 'institution_full';
  }

  async function runMove(
    userId: string,
    from: string | null,
    to: string | null,
    reason: string,
  ): Promise<MoveOutcome> {
    const outcome = await mover.move({ userId, from, to, reason });
    if (outcome.status === 'refused' || outcome.status === 'busy') {
      logger.warn(`[bdren] moving user ${userId} to ${to ?? 'no institution'}: ${outcome.status}`);
    }
    return outcome;
  }

  /**
   * A move of this person left unfinished (a crash, a failure) is finished first, so the review
   * decides from where they really are: a further move then redirects them if coverage changed
   * since. Resolves to the user when a move was finished, `busy` while another trigger runs it.
   */
  async function finishUnfinishedMove(userId: string): Promise<MemberRecord | 'busy' | null> {
    const outcome = await mover.resume(userId);
    if (!outcome) {
      return null;
    }
    if (outcome.status === 'busy') {
      return 'busy';
    }
    return runAsSystem(() => users().findById(userId).lean<MemberRecord>().exec());
  }

  async function reviewExistingMember(
    user: ReviewedUser,
    options: ReviewOptions = {},
  ): Promise<MemberRecord | null> {
    try {
      /** A tenantless SSO user may carry no account scope yet; only the identity matters for a lookup. */
      const who = allowanceSubjectFor(
        { ...user, accountScope: user.tenantId ? user.accountScope : 'standalone' },
        config,
      );
      if (!who || (await isPlatformStaff(who.userId, user.role, user.email))) {
        return null;
      }
      const settled = await finishUnfinishedMove(who.userId);
      if (settled === 'busy') {
        return null;
      }
      const current = settled ? settled.tenantId || null : user.tenantId || null;
      const changed =
        settled && (settled.tenantId || null) !== (user.tenantId || null) ? settled : null;
      const subject = settled
        ? allowanceSubjectFor(
            {
              ...user,
              tenantId: current ?? undefined,
              accountScope: current ? 'institution' : 'standalone',
            },
            config,
          )
        : who;
      if (!subject) {
        return changed;
      }
      const currentInstitution = current ? await linkedInstitutionOf(current) : null;
      const allowance = options.fresh
        ? await service.refresh(subject)
        : await service.getAllowance({ ...subject, idToken: options.idToken });
      const organizationId =
        allowance.planSource === 'institution' ? allowance.institutionId : null;
      const target = organizationId ? await findByOrganization(organizationId) : null;
      /** A member migrated to SSO stays in their institution until bdren.ai says otherwise. */
      const held = current != null && user.bdrenHoldTenantId === current;
      if (target && target.tenantId === current) {
        if (held) {
          await releaseHold(who.userId, current);
        }
        return changed;
      }
      const noted = user.bdrenNotedOrganizationId;
      const mismatch = (reason: string, org: string, institutionTenantId: string | null) =>
        noteMismatch(
          who.userId,
          org,
          { institutionTenantId, currentTenantId: current, reason },
          noted,
        );
      if (currentInstitution === undefined) {
        if (organizationId) {
          await mismatch('legacy_tenant', organizationId, target?.tenantId ?? null);
        }
        return changed;
      }
      if (!TRUSTED_ORIGINS.has(allowance.origin)) {
        if (currentInstitution) {
          await mismatch(
            'unverified_answer',
            currentInstitution.bdrenOrganizationId,
            currentInstitution.tenantId,
          );
        }
        return changed;
      }
      const refusal = organizationId ? joinRefusal(target) : null;
      if (organizationId && refusal) {
        await mismatch(refusal, organizationId, target?.tenantId ?? null);
      }
      const to = organizationId && !refusal && target ? target.tenantId : null;
      if (held && to === null && currentInstitution) {
        await mismatch(
          'migrated_not_covered',
          currentInstitution.bdrenOrganizationId,
          currentInstitution.tenantId,
        );
        return changed;
      }
      if (to === current) {
        return changed;
      }
      let outcome = await runMove(who.userId, current, to, moveReason(current, to));
      if (outcome.status === 'refused' && to && organizationId) {
        await mismatch(`move_${outcome.reason}`, organizationId, to);
        if (current && !held) {
          outcome = await runMove(who.userId, current, null, 'coverage_left');
        }
      }
      if (outcome.status === 'moved') {
        return outcome.user;
      }
      return changed;
    } catch (error) {
      logger.error('[bdren] membership review failed', error);
      return null;
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
