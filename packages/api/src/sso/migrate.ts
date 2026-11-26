import { Types } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import type { mongo } from 'mongoose';
import type { IInstitution, IUser } from '@librechat/data-schemas';
import type { HumanUserInput, ZitadelClient, ZitadelUser } from './zitadel';
import { normalizeOpenIdIssuer } from '~/auth/openid';

export type MigratingUser = Pick<
  IUser,
  | 'email'
  | 'emailVerified'
  | 'name'
  | 'username'
  | 'password'
  | 'provider'
  | 'openidIssuer'
  | 'role'
  | 'tenantId'
  | 'twoFactorEnabled'
  | 'totpSecret'
> &
  SsoUserFields & { _id: Types.ObjectId; openidId?: string | null };

/** Fields the bdren.ai link adds to users; this release's schema does not declare them yet. */
type SsoUserFields = { ssoMigratedAt?: Date; bdrenHoldTenantId?: string };

/** Set by hand (or by synapse-admin once released) to the institution's bdren.ai organization id. */
export type BdrenInstitutionLink = { bdrenOrganizationId?: string | null };

type InstitutionRef = Pick<IInstitution, 'tenantId' | 'status'> & BdrenInstitutionLink;

const PLATFORM_ROLES: ReadonlySet<string> = new Set<string>([
  SystemRoles.ADMIN,
  'PLATFORM_SUPERADMIN',
]);

export type UserStatus =
  | 'created'
  | 'linked_existing'
  | 'resumed'
  | 'would_create'
  | 'would_link'
  | 'would_resume'
  | 'already_linked'
  | 'other_provider'
  | 'platform_staff'
  | 'no_email'
  | 'unmapped_tenant'
  | 'conflict'
  | 'error';

export type ConflictReason =
  | 'duplicate_email'
  | 'multiple_zitadel_users'
  | 'email_unverified_in_zitadel'
  | 'email_in_other_organization'
  | 'username_taken'
  | 'id_taken'
  | 'synapse_account_exists'
  | 'changed_during_migration';

/** One user's outcome, keyed by Synapse `_id` only: no email, name or hash ever goes in a report. */
export interface UserReport {
  id: string;
  status: UserStatus;
  reason?: string;
  zitadelUserId?: string;
  organizationId?: string;
  tenantId?: string;
  noPassword?: true;
  twoFactor?: true;
  totpImported?: true;
  emailUnverified?: true;
  unmappedTenant?: true;
}

export interface TenantSummary {
  users: number;
  organizationId: string | null;
  mapped: boolean;
  institution: 'active' | 'closed' | 'missing' | 'none';
  linkedToBdren: boolean;
}

export interface MigrationReport {
  mode: 'dry-run' | 'apply';
  issuer: string;
  /** Whether ZITADEL was asked about existing users; a dry run without a token plans blind. */
  zitadelChecked: boolean;
  startedAt: string;
  finishedAt?: string;
  scanned: number;
  counts: Partial<Record<UserStatus, number>>;
  conflicts: Partial<Record<ConflictReason, number>>;
  flags: {
    noPassword: number;
    twoFactor: number;
    totpImported: number;
    emailUnverified: number;
    unmappedTenant: number;
  };
  tenants: Record<string, TenantSummary>;
  users: UserReport[];
}

export interface MigrationOptions {
  apply: boolean;
  /** The OpenID issuer Synapse signs in with (`OPENID_ISSUER`). */
  issuer: string;
  /** The ZITADEL organization for individuals and for tenants without a mapping. */
  defaultOrganizationId: string;
  /** ZITADEL organization ids keyed by Synapse `tenantId` or by the institution's `bdrenOrganizationId`. */
  organizationMap?: Record<string, string>;
  /** `default` puts users of an unmapped tenant in the default organization; `skip` leaves them out. */
  unmapped?: 'default' | 'skip';
  /** Platform staff (platform roles, active `PlatformAdmin` rows) keep the local login synapse-admin uses unless this is set. */
  includeAdmins?: boolean;
  /** Superadmins named only by configuration (`PLATFORM_SUPERADMIN_EMAILS`); also staff. */
  staffEmails?: string[];
  batchSize?: number;
  userIds?: string[];
  now?: () => Date;
  onBatch?: (report: MigrationReport) => void | Promise<void>;
}

export interface MigrationDeps {
  db: mongo.Db;
  /** Required to apply; without it a dry run plans without asking ZITADEL. */
  zitadel?: ZitadelClient;
  /** Decrypts a stored Synapse TOTP secret to base32, or `null`. */
  readTotpSecret?: (stored: string) => Promise<string | null>;
}

type Plan =
  | { kind: 'create'; userId: string }
  | { kind: 'link' | 'resume'; userId: string }
  | { kind: 'conflict'; reason: ConflictReason };

type Target = { organizationId: string | null; unmapped: boolean };

const DEFAULT_BATCH_SIZE = 20;
const MAX_NAME_LENGTH = 200;
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const WOULD: Record<'create' | 'link' | 'resume', UserStatus> = {
  create: 'would_create',
  link: 'would_link',
  resume: 'would_resume',
};
const DONE: Record<'create' | 'link' | 'resume', UserStatus> = {
  create: 'created',
  link: 'linked_existing',
  resume: 'resumed',
};

const PROJECTION = {
  email: 1,
  emailVerified: 1,
  name: 1,
  username: 1,
  password: 1,
  provider: 1,
  openidId: 1,
  openidIssuer: 1,
  role: 1,
  tenantId: 1,
  twoFactorEnabled: 1,
  totpSecret: 1,
} as const;

/** Refuses a database whose name looks like production unless the caller says so explicitly. */
export function isProductionDbName(name: string): boolean {
  return /prod/i.test(name);
}

const normalizeEmail = (email: string | undefined): string => (email ?? '').trim().toLowerCase();

/** Given, family and display names for ZITADEL, which requires both name parts. */
export function profileNames(
  user: Pick<MigratingUser, 'name' | 'username' | 'email'>,
): Pick<HumanUserInput, 'givenName' | 'familyName' | 'displayName'> {
  const display = (
    user.name?.trim() ||
    user.username?.trim() ||
    normalizeEmail(user.email).split('@')[0] ||
    'User'
  ).slice(0, MAX_NAME_LENGTH);
  const [given, ...rest] = display.split(/\s+/);
  return { displayName: display, givenName: given, familyName: rest.join(' ') || given };
}

async function duplicateEmails(users: mongo.Collection<MigratingUser>): Promise<Set<string>> {
  const groups = await users
    .aggregate<{
      _id: string;
    }>([
      { $match: { email: { $type: 'string', $ne: '' } } },
      { $group: { _id: { $toLower: { $trim: { input: '$email' } } }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $project: { _id: 1 } },
    ])
    .toArray();
  return new Set(groups.map((group) => group._id));
}

export interface Staff {
  ids: Set<string>;
  emails: Set<string>;
}

export async function loadStaff(db: mongo.Db, configured: string[] = []): Promise<Staff> {
  const rows = await db
    .collection<{ userId?: Types.ObjectId | string; email?: string }>('platformadmins')
    .find({ active: true }, { projection: { userId: 1, email: 1 } })
    .toArray();
  return {
    ids: new Set(rows.filter((row) => row.userId).map((row) => String(row.userId))),
    emails: new Set(
      [...rows.map((row) => row.email), ...configured].map(normalizeEmail).filter(Boolean),
    ),
  };
}

/**
 * Platform staff keep synapse-admin's local login. A superadmin email (configured or an unbound
 * `PlatformAdmin` row) only marks a staff account when it belongs to no institution: Synapse never
 * treats an institution account as a superadmin (`ensurePlatformSuperadminForUser`), so an
 * institution admin whose email is also on the superadmin list is migrated like any member.
 */
export function isStaff(
  user: Pick<MigratingUser, '_id' | 'role' | 'email' | 'tenantId'>,
  staff: Staff,
): boolean {
  if (user.role != null && PLATFORM_ROLES.has(user.role)) {
    return true;
  }
  if (staff.ids.has(user._id.toHexString())) {
    return true;
  }
  return !user.tenantId && staff.emails.has(normalizeEmail(user.email));
}

async function loadInstitutions(db: mongo.Db): Promise<Map<string, InstitutionRef>> {
  const rows = await db
    .collection<InstitutionRef>('institutions')
    .find({}, { projection: { tenantId: 1, status: 1, bdrenOrganizationId: 1 } })
    .toArray();
  return new Map(rows.map((row) => [row.tenantId, row]));
}

function organizationResolver(
  options: MigrationOptions,
  institutions: Map<string, InstitutionRef>,
): (tenantId: string | undefined) => Target {
  const map = options.organizationMap ?? {};
  return (tenantId) => {
    if (!tenantId) {
      return { organizationId: options.defaultOrganizationId, unmapped: false };
    }
    const linked = institutions.get(tenantId)?.bdrenOrganizationId;
    const mapped = map[tenantId] ?? (linked ? map[linked] : undefined);
    if (mapped) {
      return { organizationId: mapped, unmapped: false };
    }
    return {
      organizationId: options.unmapped === 'skip' ? null : options.defaultOrganizationId,
      unmapped: true,
    };
  };
}

/** Why a user is left alone before any ZITADEL call, or `null` when they are a candidate. */
function skipReason(
  user: MigratingUser,
  issuer: string,
  duplicates: Set<string>,
  staff: Staff | null,
): Pick<UserReport, 'status' | 'reason'> | null {
  if (user.provider === 'openid' && user.openidId) {
    return normalizeOpenIdIssuer(user.openidIssuer) === issuer
      ? { status: 'already_linked' }
      : { status: 'other_provider', reason: 'openid_other_issuer' };
  }
  if (user.provider !== 'local') {
    return { status: 'other_provider', reason: user.provider || 'none' };
  }
  if (user.openidId) {
    return { status: 'other_provider', reason: 'local_with_openid_id' };
  }
  if (staff && isStaff(user, staff)) {
    return { status: 'platform_staff' };
  }
  if (!normalizeEmail(user.email)) {
    return { status: 'no_email' };
  }
  if (duplicates.has(normalizeEmail(user.email))) {
    return { status: 'conflict', reason: 'duplicate_email' };
  }
  return null;
}

/** An existing ZITADEL user may stand for this person only with the same, verified email in the same organization. */
function judgeExisting(
  match: ZitadelUser,
  email: string,
  organizationId: string,
): ConflictReason | null {
  if (normalizeEmail(match.email ?? undefined) !== email) {
    return 'id_taken';
  }
  if (!match.emailVerified) {
    return 'email_unverified_in_zitadel';
  }
  return match.organizationId === organizationId ? null : 'email_in_other_organization';
}

async function planIdentity(
  zitadel: ZitadelClient,
  userId: string,
  email: string,
  organizationId: string,
): Promise<Plan> {
  const own = await zitadel.getUser(userId);
  if (own) {
    return normalizeEmail(own.email ?? undefined) === email
      ? { kind: 'resume', userId }
      : { kind: 'conflict', reason: 'id_taken' };
  }
  const matches = await zitadel.findUsersByEmail(email);
  if (matches.length === 0) {
    return { kind: 'create', userId };
  }
  if (matches.length > 1) {
    return { kind: 'conflict', reason: 'multiple_zitadel_users' };
  }
  const reason = judgeExisting(matches[0], email, organizationId);
  return reason ? { kind: 'conflict', reason } : { kind: 'link', userId: matches[0].userId };
}

/** After ZITADEL said "already exists": an earlier run's user, the same person by username, or a conflict. */
async function settleExisting(
  zitadel: ZitadelClient,
  input: HumanUserInput,
  email: string,
): Promise<Plan> {
  const own = await zitadel.getUser(input.userId);
  if (own) {
    return normalizeEmail(own.email ?? undefined) === email
      ? { kind: 'resume', userId: input.userId }
      : { kind: 'conflict', reason: 'id_taken' };
  }
  const holders = await zitadel.findUsersByUsername(input.username);
  if (holders.length !== 1) {
    return { kind: 'conflict', reason: 'username_taken' };
  }
  const reason = judgeExisting(holders[0], email, input.organizationId);
  if (reason === 'id_taken') {
    return { kind: 'conflict', reason: 'username_taken' };
  }
  return reason ? { kind: 'conflict', reason } : { kind: 'link', userId: holders[0].userId };
}

function emptyReport(options: MigrationOptions, issuer: string, checked: boolean, now: Date) {
  const report: MigrationReport = {
    mode: options.apply ? 'apply' : 'dry-run',
    issuer,
    zitadelChecked: checked,
    startedAt: now.toISOString(),
    scanned: 0,
    counts: {},
    conflicts: {},
    flags: { noPassword: 0, twoFactor: 0, totpImported: 0, emailUnverified: 0, unmappedTenant: 0 },
    tenants: {},
    users: [],
  };
  return report;
}

function record(report: MigrationReport, entry: UserReport): void {
  report.scanned += 1;
  report.counts[entry.status] = (report.counts[entry.status] ?? 0) + 1;
  if (entry.status === 'conflict' && entry.reason) {
    const reason = entry.reason as ConflictReason;
    report.conflicts[reason] = (report.conflicts[reason] ?? 0) + 1;
  }
  for (const flag of [
    'noPassword',
    'twoFactor',
    'totpImported',
    'emailUnverified',
    'unmappedTenant',
  ] as const) {
    if (entry[flag]) {
      report.flags[flag] += 1;
    }
  }
  report.users.push(entry);
}

function institutionState(
  tenantId: string | undefined,
  institution: InstitutionRef | undefined,
): TenantSummary['institution'] {
  if (!tenantId) {
    return 'none';
  }
  if (!institution) {
    return 'missing';
  }
  return institution.status === 'active' ? 'active' : 'closed';
}

function summarizeTenant(
  report: MigrationReport,
  tenantId: string | undefined,
  target: Target,
  institutions: Map<string, InstitutionRef>,
): void {
  const key = tenantId ?? '(none)';
  const existing = report.tenants[key];
  if (existing) {
    existing.users += 1;
    return;
  }
  const institution = tenantId ? institutions.get(tenantId) : undefined;
  report.tenants[key] = {
    users: 1,
    organizationId: target.organizationId,
    mapped: !target.unmapped,
    institution: institutionState(tenantId, institution),
    linkedToBdren: typeof institution?.bdrenOrganizationId === 'string',
  };
}

/**
 * Moves Synapse's local-password users to ZITADEL: each gets a ZITADEL user (id = their Synapse
 * `_id`, same bcrypt hash, verified email only when Synapse had it verified) and their Synapse account
 * becomes that OpenID identity in one write. Nothing else on the account changes, so `_id`, tenant
 * and data stay. Users already linked are skipped, so a rerun picks up where a stopped run ended.
 */
export async function migrateUsersToZitadel(
  deps: MigrationDeps,
  options: MigrationOptions,
): Promise<MigrationReport> {
  const issuer = normalizeOpenIdIssuer(options.issuer);
  if (!issuer) {
    throw new Error('An OpenID issuer is required');
  }
  if (!options.defaultOrganizationId) {
    throw new Error('A default ZITADEL organization id is required');
  }
  if (options.apply && !deps.zitadel) {
    throw new Error('Applying needs a ZITADEL client');
  }
  const now = options.now ?? (() => new Date());
  const users = deps.db.collection<MigratingUser>('users');
  const [institutions, duplicates, staff] = await Promise.all([
    loadInstitutions(deps.db),
    duplicateEmails(users),
    options.includeAdmins ? null : loadStaff(deps.db, options.staffEmails),
  ]);
  const resolveTarget = organizationResolver(options, institutions);
  const report = emptyReport(options, issuer, deps.zitadel != null, now());

  async function totpFor(user: MigratingUser): Promise<string | undefined> {
    if (!user.twoFactorEnabled || !user.totpSecret || !deps.readTotpSecret) {
      return undefined;
    }
    try {
      return (await deps.readTotpSecret(user.totpSecret)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function link(user: MigratingUser, zitadelUserId: string): Promise<ConflictReason | null> {
    const clash = await users.findOne(
      { openidId: zitadelUserId, openidIssuer: issuer, _id: { $ne: user._id } },
      { projection: { _id: 1 } },
    );
    if (clash) {
      return 'synapse_account_exists';
    }
    if (!options.apply) {
      return null;
    }
    const written = await users.updateOne(
      { _id: user._id, provider: 'local', openidId: { $in: [null, ''] } },
      {
        $set: {
          provider: 'openid',
          openidId: zitadelUserId,
          openidIssuer: issuer,
          ssoMigratedAt: now(),
          ...(user.tenantId ? { bdrenHoldTenantId: user.tenantId } : null),
        },
      },
    );
    return written.matchedCount === 1 ? null : 'changed_during_migration';
  }

  async function migrateOne(user: MigratingUser): Promise<UserReport> {
    const id = user._id.toHexString();
    const skip = skipReason(user, issuer as string, duplicates, staff);
    if (skip) {
      return { id, ...skip, ...(user.tenantId ? { tenantId: user.tenantId } : null) };
    }
    const target = resolveTarget(user.tenantId);
    const totpSecret = await totpFor(user);
    const hash = user.password && BCRYPT.test(user.password) ? user.password : undefined;
    const base: UserReport = {
      id,
      status: 'would_create',
      ...(user.tenantId ? { tenantId: user.tenantId } : null),
      ...(target.organizationId ? { organizationId: target.organizationId } : null),
      ...(hash ? null : { noPassword: true as const }),
      ...(user.twoFactorEnabled ? { twoFactor: true as const } : null),
      ...(totpSecret ? { totpImported: true as const } : null),
      ...(user.emailVerified ? null : { emailUnverified: true as const }),
      ...(target.unmapped ? { unmappedTenant: true as const } : null),
    };
    summarizeTenant(report, user.tenantId, target, institutions);
    if (!target.organizationId) {
      return { ...base, status: 'unmapped_tenant' };
    }
    if (!deps.zitadel) {
      return base;
    }
    const email = normalizeEmail(user.email);
    const input: HumanUserInput = {
      userId: id,
      organizationId: target.organizationId,
      username: email,
      email,
      emailVerified: user.emailVerified === true,
      ...profileNames(user),
      ...(hash ? { passwordHash: hash } : null),
      ...(totpSecret ? { totpSecret } : null),
    };
    try {
      let plan = await planIdentity(deps.zitadel, id, email, target.organizationId);
      if (plan.kind === 'conflict') {
        return { ...base, status: 'conflict', reason: plan.reason };
      }
      if (options.apply && plan.kind === 'create') {
        const created = await deps.zitadel.createHumanUser(input);
        plan =
          created.status === 'created'
            ? { kind: 'create', userId: created.userId }
            : await settleExisting(deps.zitadel, input, email);
        if (plan.kind === 'conflict') {
          return { ...base, status: 'conflict', reason: plan.reason };
        }
      }
      const clash = await link(user, plan.userId);
      if (clash) {
        return { ...base, status: 'conflict', reason: clash, zitadelUserId: plan.userId };
      }
      const status = options.apply ? DONE[plan.kind] : WOULD[plan.kind];
      return { ...base, status, zitadelUserId: plan.userId };
    } catch (error) {
      return { ...base, status: 'error', reason: (error as Error).message };
    }
  }

  async function runBatch(batch: MigratingUser[]): Promise<void> {
    const results = await Promise.all(batch.map(migrateOne));
    results.forEach((entry) => record(report, entry));
    await options.onBatch?.(report);
  }

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const filter = options.userIds?.length
    ? { _id: { $in: options.userIds.map((value) => new Types.ObjectId(value)) } }
    : {};
  const cursor = users.find(filter, { projection: PROJECTION, sort: { _id: 1 }, batchSize });
  let batch: MigratingUser[] = [];
  for await (const user of cursor) {
    batch.push(user);
    if (batch.length >= batchSize) {
      await runBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await runBatch(batch);
  }
  report.finishedAt = now().toISOString();
  return report;
}

export type UnlinkResult = 'unlinked' | 'not_migrated';

export interface UnlinkOptions {
  /** Superadmins named only by configuration (`PLATFORM_SUPERADMIN_EMAILS`); also staff. */
  staffEmails?: string[];
}

/** An individual left without an account scope would never be metered; staff stay without one. */
async function scopeAfterUnlink(
  db: mongo.Db,
  user: MigratingUser & { accountScope?: string },
  staffEmails?: string[],
): Promise<Record<string, string>> {
  if (user.tenantId || user.accountScope) {
    return {};
  }
  return isStaff(user, await loadStaff(db, staffEmails)) ? {} : { accountScope: 'standalone' };
}

/**
 * Turns a migrated account back into a local-password one (its hash was never removed). The ZITADEL
 * user is left for the operator to delete or keep. A tenantless individual without an account
 * scope is made `standalone`, as every individual is.
 */
export async function unlinkMigratedUser(
  db: mongo.Db,
  userId: string,
  options: UnlinkOptions = {},
): Promise<UnlinkResult> {
  const users = db.collection<MigratingUser & { accountScope?: string }>('users');
  const filter = {
    _id: new Types.ObjectId(userId),
    provider: 'openid',
    ssoMigratedAt: { $exists: true },
  };
  const user = await users.findOne(filter, {
    projection: { tenantId: 1, accountScope: 1, role: 1, email: 1 },
  });
  if (!user) {
    return 'not_migrated';
  }
  const written = await users.updateOne(filter, {
    $set: { provider: 'local', ...(await scopeAfterUnlink(db, user, options.staffEmails)) },
    $unset: { openidId: '', openidIssuer: '', ssoMigratedAt: '', bdrenHoldTenantId: '' },
  });
  return written.matchedCount === 1 ? 'unlinked' : 'not_migrated';
}
