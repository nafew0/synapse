#!/usr/bin/env node

/**
 * Create an active local test account in an existing institution tenant.
 *
 * The account is created through the normal registration service so that the
 * membership lifecycle, password hashing, and tenant defaults match a real
 * user. It intentionally prompts for all inputs and never prints the password.
 *
 * Usage:
 *   node config/create-tenant-test-user.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('./helpers');

const {
  createModels,
  runAsSystem,
  tenantStorage,
  InstitutionStatuses,
} = require('@librechat/data-schemas');
const {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
  SystemRoles,
} = require('librechat-data-provider');
const { registerUser } = require('~/server/services/AuthService');
const { grantPermission } = require('~/server/services/PermissionService');
const { askQuestion } = require('./helpers');
const connect = require('./connect');

const { Agent, Institution, User } = createModels(mongoose);

let shuttingDown = false;

async function closeAndExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await mongoose.disconnect().catch(() => undefined);
  process.exit(code);
}

process.once('SIGINT', () => {
  console.error('\nCancelled; closing the database connection...');
  void closeAndExit(130);
});
process.once('SIGTERM', () => {
  console.error('\nStopped; closing the database connection...');
  void closeAndExit(143);
});

function usernameFromEmail(email) {
  const localPart = email.slice(0, email.indexOf('@')).toLowerCase();
  const normalized = localPart.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  return normalized.slice(0, 40) || 'tenant_test_user';
}

function nameFromEmail(email) {
  return (
    email
      .slice(0, email.indexOf('@'))
      .replace(/[._+-]+/g, ' ')
      .trim() || 'Test User'
  );
}

async function selectTenant() {
  const tenants = await runAsSystem(() =>
    Institution.find({})
      .select('tenantId name status')
      .sort({ name: 1, tenantId: 1 })
      .lean()
      .exec(),
  );

  if (!tenants.length) {
    throw new Error('No institution tenants exist in this database.');
  }

  console.purple('\nAvailable tenants:');
  tenants.forEach((tenant, index) => {
    console.log(
      `  ${index + 1}. ${tenant.name || tenant.tenantId} [${tenant.tenantId}] (${tenant.status || 'unknown'})`,
    );
  });

  const answer = (await askQuestion('Select a tenant by number:')).trim();
  const selection = Number.parseInt(answer, 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > tenants.length) {
    throw new Error('Invalid tenant selection.');
  }

  const tenant = tenants[selection - 1];
  if (tenant.status && tenant.status !== InstitutionStatuses.ACTIVE) {
    throw new Error(`Tenant "${tenant.tenantId}" is not active and cannot receive new accounts.`);
  }

  return tenant;
}

async function promptForAccount() {
  const email = (await askQuestion('Email:')).trim().toLowerCase();
  if (!email.includes('@')) {
    throw new Error('Enter a valid email address.');
  }

  const password = await askQuestion('Password:');
  if (!password) {
    throw new Error('Password is required.');
  }

  return {
    email,
    password,
    username: usernameFromEmail(email),
    name: nameFromEmail(email),
  };
}

/**
 * Mirrors the legacy BdREN test-user access model: the account can view the
 * Office Assistant and each specialist directly. This makes it suitable for
 * validating specialist permissions, while tenant-wide production access
 * continues to use the delegated group model.
 */
async function grantOfficeAssistantViewAccess({ userId, tenantId }) {
  const [grantingAdmin, master] = await runAsSystem(() =>
    Promise.all([
      User.findOne({ role: SystemRoles.ADMIN }).select('_id').lean().exec(),
      Agent.findOne({ id: 'agent_office_assistant' }).lean().exec(),
    ]),
  );
  if (!grantingAdmin) {
    throw new Error('No platform administrator was found to record Office Assistant grants.');
  }
  if (!master) {
    throw new Error(
      'Office Assistant was not found. The test account was created without agent grants.',
    );
  }

  const specialistIds = (master.edges || [])
    .map((edge) => edge.to)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const specialists = specialistIds.length
    ? await runAsSystem(() =>
        Agent.find({ id: { $in: specialistIds } })
          .lean()
          .exec(),
      )
    : [];
  if (specialists.length !== specialistIds.length) {
    throw new Error('One or more Office Assistant specialists could not be found.');
  }

  await Promise.all(
    [master, ...specialists].map((agent) =>
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantingAdmin._id,
        tenantId,
      }),
    ),
  );

  return specialists.length;
}

async function main() {
  await connect();

  console.purple('--------------------------------------------');
  console.purple('Create a tenant test account');
  console.purple('--------------------------------------------');

  const tenant = await selectTenant();
  const account = await promptForAccount();

  const duplicate = await runAsSystem(() =>
    User.findOne({ $or: [{ email: account.email }, { username: account.username }] })
      .select('email username tenantId')
      .lean()
      .exec(),
  );
  if (duplicate) {
    throw new Error(
      `An account already uses ${duplicate.email === account.email ? 'that email' : `the generated username "${account.username}"`}.`,
    );
  }

  const result = await tenantStorage.run({ tenantId: tenant.tenantId }, async () =>
    registerUser(
      {
        email: account.email,
        password: account.password,
        confirm_password: account.password,
        name: account.name,
        username: account.username,
      },
      { tenantId: tenant.tenantId, emailVerified: true, provider: 'local' },
    ),
  );

  if (result.status !== 200) {
    throw new Error(result.message || `Account creation failed with status ${result.status}.`);
  }

  const user = await runAsSystem(() =>
    User.findOne({ email: account.email })
      .select('_id email username tenantId accountScope membershipStatus emailVerified')
      .lean()
      .exec(),
  );
  if (!user || user.tenantId !== tenant.tenantId || user.membershipStatus !== 'active') {
    throw new Error(
      'Account registration did not produce an active member in the selected tenant.',
    );
  }

  const specialistCount = await grantOfficeAssistantViewAccess({
    userId: user._id,
    tenantId: tenant.tenantId,
  });

  console.green('\nTest account created successfully.');
  console.green(`Tenant: ${tenant.tenantId}`);
  console.green(`Email: ${user.email}`);
  console.green(`Username: ${user.username}`);
  console.green(`Email verified: ${user.emailVerified}`);
  console.green(
    `Office Assistant access: granted directly to the master and ${specialistCount} specialist(s).`,
  );
}

main()
  .then(() => closeAndExit(0))
  .catch(async (error) => {
    console.red(`\nFailed: ${error.message}`);
    await closeAndExit(1);
  });
