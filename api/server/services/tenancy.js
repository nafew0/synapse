const { PrincipalType, SystemRoles, roleDefaults } = require('librechat-data-provider');
const { updateTenantInterfacePermissions } = require('@librechat/api');
const {
  INSTITUTION_ADMIN_ROLE,
  SystemCapabilities,
  runAsSystem,
  tenantStorage,
} = require('@librechat/data-schemas');
const { getAppConfig } = require('./Config');
const models = require('~/db/models');
const db = require('~/models');

/** Resolved on use rather than at module load: this module sits on the require
 * chain of routes whose tests stub `@librechat/data-schemas`, and dereferencing
 * the enum during import makes the whole chain fail to load. */
function getInstitutionAdminCapabilities() {
  return [
    SystemCapabilities.ACCESS_ADMIN,
    SystemCapabilities.READ_USERS,
    SystemCapabilities.MANAGE_USERS,
    SystemCapabilities.READ_GROUPS,
    SystemCapabilities.MANAGE_GROUPS,
    SystemCapabilities.READ_ROLES,
    SystemCapabilities.READ_USAGE,
  ];
}

const institutionAdminDescription =
  'Tenant-scoped institution administrator. Platform authority is not inherited.';

async function ensureInstitutionAdminRole(tenantId) {
  await tenantStorage.run({ tenantId }, async () => {
    const role = await db.getRoleByName(INSTITUTION_ADMIN_ROLE);
    if (!role) {
      await db.createRoleByName({
        name: INSTITUTION_ADMIN_ROLE,
        description: institutionAdminDescription,
        permissions: roleDefaults[SystemRoles.USER].permissions,
      });
    }
  });

  await Promise.all(
    getInstitutionAdminCapabilities().map((capability) =>
      db.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: INSTITUTION_ADMIN_ROLE,
        capability,
        tenantId,
      }),
    ),
  );
  await syncTenantInterfacePermissions([tenantId]);
}

/**
 * Applies the interface settings from `librechat.yaml` to institutions' own
 * USER and INSTITUTION_ADMIN role copies, which are otherwise seeded from
 * hardcoded defaults. Returns the tenants that failed.
 */
async function syncTenantInterfacePermissions(tenantIds) {
  return await updateTenantInterfacePermissions({
    tenantIds,
    getAppConfig,
    getRoleByName: db.getRoleByName,
    updateAccessPermissions: db.updateAccessPermissions,
  });
}

/** Startup repair: every existing institution picks up the current interface config. */
async function syncAllTenantInterfacePermissions() {
  const institutions = await runAsSystem(() =>
    models.Institution.find({}).select('tenantId').lean().exec(),
  );
  return await syncTenantInterfacePermissions(
    institutions.map((institution) => institution.tenantId).filter(Boolean),
  );
}

async function appointInstitutionAdmin({ tenantId, userId }) {
  await ensureInstitutionAdminRole(tenantId);

  return await tenantStorage.run({ tenantId }, async () => {
    const user = await db.getUserById(userId, '_id id email role tenantId');
    if (!user) {
      return null;
    }
    return await db.updateUser(userId, { role: INSTITUTION_ADMIN_ROLE });
  });
}

async function revokeInstitutionAdmin({ tenantId, userId }) {
  return await tenantStorage.run({ tenantId }, async () => {
    const user = await db.getUserById(userId, '_id id email role tenantId');
    if (!user) {
      return null;
    }
    if (user.role !== INSTITUTION_ADMIN_ROLE) {
      return user;
    }
    return await db.updateUser(userId, { role: SystemRoles.USER });
  });
}

module.exports = {
  getInstitutionAdminCapabilities,
  ensureInstitutionAdminRole,
  syncAllTenantInterfacePermissions,
  syncTenantInterfacePermissions,
  appointInstitutionAdmin,
  revokeInstitutionAdmin,
};
