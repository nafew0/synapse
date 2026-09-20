const path = require('path');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { createModels, tenantStorage, runAsSystem } = require('@librechat/data-schemas');

const connect = require('./connect');
const { seedDefaultRoles } = require('~/models');

createModels(mongoose);

/**
 * Seeds the ACL roles that grant ownership of a resource.
 *
 * AccessRole is tenant-isolated: `applyTenantIsolation` injects `where({ tenantId })` into every
 * query when a tenant context is active, with no fallback to unscoped rows. A role stored without
 * a tenantId is therefore invisible to a request running under one, which surfaces as
 * "Role skill_owner not found" from grantPermission after the permission check has already passed.
 *
 * Read without `--tenant` to see every role and the tenant it belongs to; that listing runs as
 * system, so it is not filtered. Pass `--tenant=<id>` to seed the roles that tenant is missing.
 *
 * `seedDefaultRoles` writes with `$setOnInsert` under upsert, so existing roles are never
 * modified. Under a tenant context the upsert filter carries the tenantId, so the inserted
 * document is scoped to that tenant.
 *
 * Usage:
 *   node config/seed-access-roles.js                   # list every role and its tenant
 *   node config/seed-access-roles.js --apply           # seed global (untenanted) roles
 *   node config/seed-access-roles.js --tenant=bdren    # what is bdren missing?
 *   node config/seed-access-roles.js --tenant=bdren --apply
 *   node config/seed-access-roles.js --all-tenants     # every tenant in `institutions`
 *   node config/seed-access-roles.js --all-tenants --apply
 */

function parseArgs(argv) {
  const tenantArg = argv.find((arg) => arg.startsWith('--tenant='));
  return {
    apply: argv.includes('--apply'),
    allTenants: argv.includes('--all-tenants'),
    tenantId: tenantArg ? tenantArg.slice('--tenant='.length) : undefined,
  };
}

/**
 * Every tenant on the deployment, newest last. Read through the raw driver: `institutions` has
 * no model here, and the collection is the registry the rest of the product treats as
 * authoritative for what a tenant is.
 */
async function readTenantIds() {
  const rows = await mongoose.connection.db
    .collection('institutions')
    .find({}, { projection: { tenantId: 1, name: 1, status: 1, _id: 0 } })
    .toArray();
  return rows.filter((row) => typeof row.tenantId === 'string' && row.tenantId !== '');
}

/** Reads every role regardless of tenant, so the listing is a true inventory. */
async function readAllRoles() {
  const AccessRole = mongoose.models.AccessRole;
  if (!AccessRole) {
    throw new Error('AccessRole model is not registered; cannot read existing roles.');
  }
  return runAsSystem(async () =>
    AccessRole.find({}, 'accessRoleId resourceType tenantId').lean().exec(),
  );
}

function describeTenant(tenantId) {
  return tenantId ? tenantId : '(global)';
}

function report(roles, tenantId) {
  console.log(`\nRoles in the database (${roles.length}):`);
  for (const role of roles) {
    console.log(`  ${role.accessRoleId.padEnd(22)} ${describeTenant(role.tenantId)}`);
  }

  if (!tenantId) {
    return;
  }

  const scoped = new Set(
    roles.filter((role) => role.tenantId === tenantId).map((role) => role.accessRoleId),
  );
  const missing = [...new Set(roles.map((role) => role.accessRoleId))].filter(
    (id) => !scoped.has(id),
  );

  console.log(`\nVisible to tenant "${tenantId}": ${scoped.size}`);
  if (missing.length > 0) {
    console.log(`Not visible to it (${missing.length}): ${missing.join(', ')}`);
  }
}

/** Seeds one tenant and reports what it created. Returns the number of rows inserted. */
async function seedOneTenant(tenantId, before) {
  const seeded = await tenantStorage.run({ tenantId }, () => seedDefaultRoles());
  const after = await readAllRoles();
  const key = (role) => `${role.accessRoleId}\u0000${role.tenantId ?? ''}`;
  const beforeKeys = new Set(before.map(key));
  const created = after.filter((role) => !beforeKeys.has(key(role)));

  if (created.length === 0) {
    console.log(`  ${tenantId.padEnd(16)} already complete`);
  } else {
    console.log(`  ${tenantId.padEnd(16)} created ${created.length}`);
  }

  return { created: created.length, after, checked: Object.keys(seeded).length };
}

async function runAllTenants(apply) {
  const tenants = await readTenantIds();
  console.log(`\nTenants found (${tenants.length}):`);

  let roles = await readAllRoles();
  const idsFor = (tenant) =>
    new Set(roles.filter((role) => role.tenantId === tenant).map((role) => role.accessRoleId));
  const allIds = [...new Set(roles.map((role) => role.accessRoleId))];

  for (const tenant of tenants) {
    const scoped = idsFor(tenant.tenantId);
    const missing = allIds.filter((id) => !scoped.has(id)).length;
    const suspended = tenant.status && tenant.status !== 'active' ? ` [${tenant.status}]` : '';
    console.log(
      `  ${tenant.tenantId.padEnd(16)} visible ${String(scoped.size).padStart(2)}, missing ${String(missing).padStart(2)}${suspended}`,
    );
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to seed every tenant listed above.');
    return;
  }

  console.log('\nSeeding:');
  let total = 0;
  for (const tenant of tenants) {
    const result = await seedOneTenant(tenant.tenantId, roles);
    roles = result.after;
    total += result.created;
  }

  console.log(`\n✓ Seeding complete: ${total} role(s) created across ${tenants.length} tenant(s)`);
}

async function main() {
  const { apply, tenantId, allTenants } = parseArgs(process.argv.slice(2));

  console.log('\n=== Access Role Seeding ===');
  console.log(`MODE:   ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(
    `TENANT: ${allTenants ? 'every tenant in institutions' : tenantId ? tenantId : '(global / untenanted)'}`,
  );

  await connect();

  if (allTenants) {
    if (tenantId) {
      throw new Error('Pass either --all-tenants or --tenant=<id>, not both.');
    }
    await runAllTenants(apply);
    return;
  }

  const before = await readAllRoles();
  report(before, tenantId);

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to create what is missing.');
    return;
  }

  const seed = () => seedDefaultRoles();
  const seeded = tenantId ? await tenantStorage.run({ tenantId }, seed) : await runAsSystem(seed);

  const after = await readAllRoles();
  const key = (role) => `${role.accessRoleId}\u0000${role.tenantId ?? ''}`;
  const beforeKeys = new Set(before.map(key));
  const created = after.filter((role) => !beforeKeys.has(key(role)));

  console.log('');
  if (created.length === 0) {
    console.log(
      `Nothing to do: every default role already exists for ${describeTenant(tenantId)}.`,
    );
  } else {
    console.log(`Created ${created.length} role(s):`);
    for (const role of created) {
      console.log(`  [create] ${role.accessRoleId.padEnd(22)} ${describeTenant(role.tenantId)}`);
    }
  }

  console.log(`\n✓ Seeding complete (${Object.keys(seeded).length} default roles checked)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n✗ Seeding failed:');
    console.error(error.message ?? error);
    process.exit(1);
  });
