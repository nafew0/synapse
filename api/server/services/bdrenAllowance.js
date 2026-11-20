const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  overrideActive,
  readBdrenConfig,
  allowanceSubjectFor,
  fallbackAllowance,
  createAllowanceClient,
  createAllowanceService,
  createProvisioner,
  reserveMoveSeat,
  releaseMoveSeat,
  createMemberMover,
  createMemberPlacer,
  createWebhookHandler,
  normalizeOpenIdIssuer,
  quotaAccountFor,
} = require('@librechat/api');

const config = readBdrenConfig();
const client = createAllowanceClient(config);
const service = createAllowanceService({ config, client });

/** Resolved on use: the member service builds the whole model registry at import time. */
const place = createMemberPlacer({
  activate: (args) =>
    require('~/server/services/institutionMembers').activateProvisionedMember(args),
});

const recordAuditEntry = (input, options) => require('~/models').recordAuditEntry(input, options);

/** Moves an existing person, with their data, between institutions; each seat change is applied once per move. */
const mover = createMemberMover({
  reserveSeat: reserveMoveSeat,
  releaseSeat: releaseMoveSeat,
  syncMember: (args) => require('~/server/services/tenantAgentAccess').syncTenantMemberSafely(args),
  clearOverrides: (tenantId) =>
    require('~/server/services/Config/app').clearOverrideCache(tenantId),
  recordAuditEntry,
});

const STRANDED_MOVE_INTERVAL_MS = 5 * 60_000;

/** Finishes moves left unfinished by a crash, and runs due late sweeps, every few minutes. */
function startMoveRecovery() {
  if (!config.enabled) {
    return;
  }
  const timer = setInterval(() => {
    mover
      .resumeStranded()
      .catch((error) => logger.error('[bdren] resuming unfinished member moves failed', error));
  }, STRANDED_MOVE_INTERVAL_MS);
  timer.unref?.();
}
startMoveRecovery();

/** Resolved on use: `tenancy` sits on routes' require chains that stub parts of data-schemas. */
const provisioner = createProvisioner({
  config,
  client,
  service,
  recordAuditEntry,
  place,
  mover,
  onCreated: (tenantId) =>
    require('~/server/services/tenancy').ensureInstitutionAdminRole(tenantId),
});

/** The Synapse user behind a bdren.ai identity, as the meter knows them. */
async function findSubject(issuer, subject) {
  const user = await runAsSystem(() =>
    mongoose.models.User.findOne({ openidId: subject, openidIssuer: normalizeOpenIdIssuer(issuer) })
      .select('tenantId accountScope openidId openidIssuer')
      .lean()
      .exec(),
  );
  return allowanceSubjectFor(user, config);
}

const ORG_TENANT_TTL_MS = 60_000;
const orgTenants = new Map();

/** The Synapse tenant a bdren.ai organization is mapped to, cached briefly. */
async function tenantOfOrganization(organizationId) {
  const hit = orgTenants.get(organizationId);
  if (hit && Date.now() - hit.at < ORG_TENANT_TTL_MS) {
    return hit.tenantId;
  }
  const institution = await runAsSystem(() =>
    mongoose.models.Institution.findOne({ bdrenOrganizationId: organizationId })
      .select('tenantId')
      .lean()
      .exec(),
  );
  const tenantId = institution?.tenantId ?? null;
  orgTenants.set(organizationId, { tenantId, at: Date.now() });
  return tenantId;
}

/**
 * The seat ceiling pools usage in one Synapse tenant, so it applies only when the seat's
 * organization is the one mapped to the tenant the user is metered under.
 */
async function withCeilingForTenant(allowance, account) {
  if (!allowance.institution) {
    return allowance;
  }
  const tenantId = allowance.institutionId
    ? await tenantOfOrganization(allowance.institutionId)
    : null;
  if (tenantId === account) {
    return allowance;
  }
  logger.warn("[bdren] seat organization is not mapped to the user's tenant; ceiling not applied");
  return { ...allowance, institution: null };
}

/**
 * The allowance a request is metered against, or `null` when bdren.ai does not manage this user
 * (the link is off, they did not sign in through bdren.ai, or a support override is in force).
 * A failure reading it yields the Free fallback, never "no limit".
 */
async function getRequestAllowance(user, memberPackage = user?.usagePackage) {
  if (!config.enabled || overrideActive(memberPackage)) {
    return null;
  }
  const who = allowanceSubjectFor(user, config);
  if (!who) {
    return null;
  }
  try {
    return await withCeilingForTenant(await service.getAllowance(who), who.account);
  } catch (error) {
    logger.error('[bdren] allowance lookup failed; using the Free fallback', error);
    return fallbackAllowance(config, new Date());
  }
}

/** A `membership.coverage_changed` for a person: ask bdren.ai afresh and move them if it changed. */
async function reviewMember(issuer, subject) {
  const user = await runAsSystem(() =>
    mongoose.models.User.findOne({ openidId: subject, openidIssuer: issuer })
      .select(
        'tenantId accountScope openidId openidIssuer email role bdrenNotedOrganizationId bdrenHoldTenantId',
      )
      .lean()
      .exec(),
  );
  if (user) {
    await provisioner.reviewExistingMember(user, { fresh: true });
  }
}

const webhookHandler = createWebhookHandler({
  config,
  service,
  findSubject,
  ensureInstitution: provisioner.ensureInstitutionForOrganization,
  reviewMember,
});

module.exports = {
  bdrenConfig: config,
  bdrenAllowance: service,
  getRequestAllowance,
  webhookHandler,
  bdrenProvisioner: provisioner,
  bdrenMover: mover,
  quotaAccountFor,
};
