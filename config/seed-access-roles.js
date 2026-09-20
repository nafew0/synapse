const path = require('path');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');

const connect = require('./connect');
const { seedDefaultRoles } = require('~/models');

createModels(mongoose);

/**
 * Seeds the ACL roles that grant ownership of a resource.
 *
 * `sync-office-agents.js` only ensures the agent and remote-agent roles, because that is all it
 * needs. Nothing at server startup seeds the rest, so a deployment whose `accessroles` collection
 * was populated by that script alone is missing the skill, prompt-group, file and shared-link
 * roles. Creating a skill then fails at the grant with "Role skill_owner not found", after the
 * permission check has already passed.
 *
 * `seedDefaultRoles` writes with `$setOnInsert`, so roles that already exist are left exactly as
 * they are, including the plain-English names the office-agent script gave them.
 *
 * Usage:
 *   node config/seed-access-roles.js            # report what is missing
 *   node config/seed-access-roles.js --apply    # create the missing roles
 */

async function listRoleIds() {
  const AccessRole = mongoose.models.AccessRole;
  if (!AccessRole) {
    throw new Error('AccessRole model is not registered; cannot read existing roles.');
  }
  const roles = await AccessRole.find({}, 'accessRoleId resourceType').lean().exec();
  return roles;
}

async function main() {
  const apply = process.argv.includes('--apply');

  console.log('\n=== Access Role Seeding ===');
  console.log(`MODE: ${apply ? 'APPLY' : 'DRY RUN'} (re-run with --apply to create missing roles)`);

  await connect();

  const before = await listRoleIds();
  const beforeIds = new Set(before.map((role) => role.accessRoleId));
  console.log(`\nExisting roles (${before.length}):`);
  for (const role of before) {
    console.log(`  [have] ${role.accessRoleId}  (${role.resourceType})`);
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to create whatever is missing.');
    return;
  }

  const seeded = await seedDefaultRoles();
  const created = Object.values(seeded).filter((role) => !beforeIds.has(role.accessRoleId));

  console.log('');
  if (created.length === 0) {
    console.log('Nothing to do: every default role already exists.');
  } else {
    console.log(`Created ${created.length} role(s):`);
    for (const role of created) {
      console.log(`  [create] ${role.accessRoleId}  (${role.resourceType})`);
    }
  }

  console.log('\n✓ Seeding complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n✗ Seeding failed:');
    console.error(error.message ?? error);
    process.exit(1);
  });
