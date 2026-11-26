import {
  InstitutionStatuses,
  INSTITUTION_ADMIN_ROLE,
  InstitutionMembershipStatuses,
} from '@librechat/data-schemas';
import type { IInstitution } from '@librechat/data-schemas';
import type { Types, mongo } from 'mongoose';
import type { BdrenInstitutionLink, MigratingUser } from './migrate';
import { isStaff, loadStaff, profileNames } from './migrate';
import { normalizeOpenIdIssuer } from '~/auth/openid';

export const MEMBER_EXPORT_FORMAT = 'synapse-members/1';

/** One migrated person as bdren.ai's `provision_user` would see them at sign-in. */
export interface ExportedPerson {
  /** ZITADEL subject (`openidId`; the Synapse `_id` for migrated accounts). */
  subject: string;
  issuer: string;
  email: string;
  emailVerified: boolean;
  name: string;
  givenName: string;
  familyName: string;
  role: 'admin' | 'member';
  status: 'active' | 'suspended';
}

export interface ExportedOrganization {
  /** bdren.ai `Organization.id` (the institution's `bdrenOrganizationId`). */
  organizationId: string;
  tenantId: string;
  name: string;
  counts: { admins: number; members: number; suspended: number };
  people: ExportedPerson[];
}

export type PersonSkip =
  | 'platform_staff'
  | 'not_migrated'
  | 'other_issuer'
  | 'removed'
  | 'institution_closed'
  | 'institution_not_linked';

export interface MemberExport {
  format: typeof MEMBER_EXPORT_FORMAT;
  exportedAt: string;
  issuer: string;
  organizations: ExportedOrganization[];
  skipped: {
    /** Institutions left out, by tenant: closed ones, and active ones not linked to bdren.ai. */
    institutions: { tenantId: string; reason: 'closed' | 'not_linked'; users: number }[];
    people: Partial<Record<PersonSkip, number>>;
  };
}

export interface MemberExportOptions {
  /** The BDREN OpenID issuer (`OPENID_ISSUER`); accounts of any other issuer are skipped. */
  issuer: string;
  /** Superadmins named only by configuration (`PLATFORM_SUPERADMIN_EMAILS`). */
  staffEmails?: string[];
  now?: () => Date;
}

type ExportingUser = Pick<
  MigratingUser,
  | '_id'
  | 'email'
  | 'emailVerified'
  | 'name'
  | 'username'
  | 'provider'
  | 'openidId'
  | 'openidIssuer'
  | 'role'
  | 'tenantId'
> & { membershipStatus?: string };

type InstitutionRow = Pick<IInstitution, 'tenantId' | 'name' | 'status'> & BdrenInstitutionLink;

const USER_PROJECTION = {
  email: 1,
  emailVerified: 1,
  name: 1,
  username: 1,
  provider: 1,
  openidId: 1,
  openidIssuer: 1,
  role: 1,
  tenantId: 1,
  membershipStatus: 1,
} as const;

const isLinked = (institution: InstitutionRow): boolean =>
  institution.status === InstitutionStatuses.ACTIVE && Boolean(institution.bdrenOrganizationId);

function institutionSkip(institution: InstitutionRow): PersonSkip | null {
  if (institution.status !== InstitutionStatuses.ACTIVE) {
    return 'institution_closed';
  }
  return institution.bdrenOrganizationId ? null : 'institution_not_linked';
}

function personSkip(
  user: ExportingUser,
  issuer: string,
  staff: Awaited<ReturnType<typeof loadStaff>>,
): PersonSkip | null {
  if (isStaff(user, staff)) {
    return 'platform_staff';
  }
  if (user.provider !== 'openid' || !user.openidId) {
    return 'not_migrated';
  }
  if (normalizeOpenIdIssuer(user.openidIssuer ?? undefined) !== issuer) {
    return 'other_issuer';
  }
  if (user.membershipStatus === InstitutionMembershipStatuses.REMOVED) {
    return 'removed';
  }
  return null;
}

function toPerson(user: ExportingUser, issuer: string): ExportedPerson {
  const names = profileNames(user);
  return {
    subject: String(user.openidId),
    issuer,
    email: (user.email ?? '').trim().toLowerCase(),
    emailVerified: user.emailVerified === true,
    name: names.displayName,
    givenName: names.givenName,
    familyName: names.familyName,
    role: user.role === INSTITUTION_ADMIN_ROLE ? 'admin' : 'member',
    status:
      user.membershipStatus === InstitutionMembershipStatuses.SUSPENDED ? 'suspended' : 'active',
  };
}

const ROLE_ORDER: Record<ExportedPerson['role'], number> = { admin: 0, member: 1 };

/** Admins first, then by email: the order bdren.ai fills seats in. */
const byRoleThenEmail = (a: ExportedPerson, b: ExportedPerson): number =>
  ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.email.localeCompare(b.email);

/**
 * Lists the migrated people of every Synapse institution linked to a bdren.ai organization, for
 * bdren.ai's `import_synapse_members`. Read-only. Platform staff, accounts not on the BDREN issuer,
 * removed members, closed and unlinked institutions are left out and counted.
 */
export async function exportMembersForBdren(
  db: mongo.Db,
  options: MemberExportOptions,
): Promise<MemberExport> {
  const issuer = normalizeOpenIdIssuer(options.issuer);
  if (!issuer) {
    throw new Error('An OpenID issuer is required');
  }
  const [institutions, staff] = await Promise.all([
    db
      .collection<InstitutionRow>('institutions')
      .find({}, { projection: { tenantId: 1, name: 1, status: 1, bdrenOrganizationId: 1 } })
      .toArray(),
    loadStaff(db, options.staffEmails),
  ]);
  const byTenant = new Map(institutions.map((institution) => [institution.tenantId, institution]));
  const organizations = new Map<string, ExportedOrganization>(
    institutions.filter(isLinked).map((institution) => [
      institution.tenantId,
      {
        organizationId: String(institution.bdrenOrganizationId),
        tenantId: institution.tenantId,
        name: institution.name,
        counts: { admins: 0, members: 0, suspended: 0 },
        people: [],
      },
    ]),
  );
  const skippedPeople: Partial<Record<PersonSkip, number>> = {};
  const skippedInstitutions = new Map<string, number>();

  const cursor = db
    .collection<ExportingUser & { _id: Types.ObjectId }>('users')
    .find({ tenantId: { $in: [...byTenant.keys()] } }, { projection: USER_PROJECTION });
  for await (const user of cursor) {
    const tenantId = String(user.tenantId);
    const institution = byTenant.get(tenantId) as InstitutionRow;
    const skip = personSkip(user, issuer, staff) ?? institutionSkip(institution);
    if (skip) {
      skippedPeople[skip] = (skippedPeople[skip] ?? 0) + 1;
      if (skip === 'institution_closed' || skip === 'institution_not_linked') {
        skippedInstitutions.set(tenantId, (skippedInstitutions.get(tenantId) ?? 0) + 1);
      }
      continue;
    }
    const organization = organizations.get(tenantId) as ExportedOrganization;
    const person = toPerson(user, issuer);
    organization.people.push(person);
    organization.counts[person.role === 'admin' ? 'admins' : 'members'] += 1;
    if (person.status === 'suspended') {
      organization.counts.suspended += 1;
    }
  }

  return {
    format: MEMBER_EXPORT_FORMAT,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    issuer,
    organizations: [...organizations.values()].map((organization) => ({
      ...organization,
      people: organization.people.sort(byRoleThenEmail),
    })),
    skipped: {
      institutions: institutions
        .filter((institution) => !isLinked(institution))
        .map((institution) => ({
          tenantId: institution.tenantId,
          reason:
            institution.status === InstitutionStatuses.ACTIVE
              ? ('not_linked' as const)
              : ('closed' as const),
          users: skippedInstitutions.get(institution.tenantId) ?? 0,
        })),
      people: skippedPeople,
    },
  };
}
