import mongoose from 'mongoose';
import { logger, runAsSystem, InstitutionStatuses } from '@librechat/data-schemas';
import type {
  IInstitution,
  IAuditLog,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { AllowanceService } from './allowance';
import type { AllowanceClient } from './client';
import type { BdrenConfig } from './types';
import type { IdentityUser } from './identity';
import { allowanceSubjectFor } from './identity';
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
}

export interface Provisioner {
  /**
   * The tenant of a bdren.ai organization, created when Synapse does not know it yet. An existing
   * link is reused; an institution that merely looks alike (same slug) is never linked. Safe to
   * call concurrently: the unique `bdrenOrganizationId` index lets one creation win and the rest
   * read it.
   */
  ensureInstitutionForOrganization: (org: OrganizationRef) => Promise<string>;
  /**
   * The tenant a brand-new SSO user belongs in, from bdren.ai's answer for them, or `null` when
   * they are not covered by an institution, bdren.ai cannot be reached, or the link is off.
   * Never throws: login must not depend on bdren.ai.
   */
  tenantForNewMember: (identity: { issuer: string; subject: string }) => Promise<string | null>;
  /**
   * Notes, for a superadmin, an existing user who is covered by an institution that is not their
   * tenant. They are never moved: their chats and files live in the scope they already have.
   * Never throws.
   */
  reviewExistingMember: (user: IdentityUser) => Promise<void>;
}

const DUPLICATE_KEY = 11000;
const MAX_TENANT_ID_LENGTH = 40;
const MAX_ATTEMPTS = 6;
const SERVICE_ACTOR = { type: 'service', name: 'bdren.ai' } as const;

const institutions = (): Model<IInstitution> => mongoose.models.Institution as Model<IInstitution>;
const auditLog = (): Model<IAuditLog> => mongoose.models.AuditLog as Model<IAuditLog>;

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

export function createProvisioner(deps: ProvisionDeps): Provisioner {
  const { config, client, service, recordAuditEntry, onCreated } = deps;

  async function audit(input: RecordAuditEntryInput): Promise<void> {
    try {
      await recordAuditEntry(input);
    } catch (error) {
      logger.error('[bdren] provisioning audit entry failed', error);
    }
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

  async function ensureInstitution(org: OrganizationRef): Promise<IInstitution> {
    const existing = await findByOrganization(org.id);
    if (existing) {
      return existing;
    }
    const { institution, created } = await create(org);
    if (created) {
      await announce(institution, org);
    }
    return institution;
  }

  async function tenantForNewMember(identity: {
    issuer: string;
    subject: string;
  }): Promise<string | null> {
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
      if (institution.status === InstitutionStatuses.CLOSED) {
        logger.warn(`[bdren] institution ${institution.tenantId} is closed; new member not placed`);
        return null;
      }
      return institution.tenantId;
    } catch (error) {
      logger.error('[bdren] could not place a new SSO user in an institution', error);
      return null;
    }
  }

  async function alreadyNoted(userId: string, organizationId: string): Promise<boolean> {
    const found = await runAsSystem(() =>
      auditLog()
        .exists({
          action: 'member.coverage_mismatch',
          'target.id': userId,
          'metadata.organizationId': organizationId,
        })
        .exec(),
    );
    return found != null;
  }

  async function reviewExistingMember(user: IdentityUser): Promise<void> {
    try {
      const who = allowanceSubjectFor(user, config);
      if (!who) {
        return;
      }
      const allowance = await service.getAllowance(who);
      if (allowance.planSource !== 'institution' || !allowance.institutionId) {
        return;
      }
      const institution = await ensureInstitution({
        id: allowance.institutionId,
        slug: allowance.institutionSlug,
        name: allowance.institutionName,
      });
      if (user.tenantId === institution.tenantId) {
        return;
      }
      if (await alreadyNoted(who.userId, allowance.institutionId)) {
        return;
      }
      logger.warn(
        `[bdren] user ${who.userId} is covered by institution ${institution.tenantId} but belongs to ${user.tenantId ?? 'no institution'}; not moved`,
      );
      await audit({
        action: 'member.coverage_mismatch',
        actor: SERVICE_ACTOR,
        target: { type: 'user', id: who.userId },
        metadata: {
          organizationId: allowance.institutionId,
          institutionTenantId: institution.tenantId,
          currentTenantId: user.tenantId ?? null,
        },
        tenantId: undefined,
      });
    } catch (error) {
      logger.error('[bdren] membership review failed', error);
    }
  }

  return {
    ensureInstitutionForOrganization: async (org) => (await ensureInstitution(org)).tenantId,
    tenantForNewMember,
    reviewExistingMember,
  };
}
