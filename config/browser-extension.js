const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { runAsSystem, createModels } = require('@librechat/data-schemas');

const { Institution } = createModels(mongoose);
const connect = require('./connect');

/**
 * Switches the browser extension on or off for one institution, and sets the sites it may never open.
 * Dry run unless `--apply` is passed.
 *
 * Usage: node config/browser-extension.js --tenant=<id> [--off] [--block=a.example,b.example] [--apply]
 */
const parseArgs = (argv) => {
  const value = (name) =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')[1]
      ?.trim() ?? '';
  return {
    apply: argv.includes('--apply'),
    off: argv.includes('--off'),
    tenantId: value('tenant'),
    blocked: value('block')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId) {
    throw new Error('--tenant is required.');
  }
  await connect();
  const institution = await runAsSystem(() =>
    Institution.findOne({ tenantId: args.tenantId }).lean(),
  );
  if (!institution) {
    throw new Error(`No institution with tenant ${args.tenantId}.`);
  }
  const before = institution.browserControl ?? {};
  console.log(`${institution.name} (${args.tenantId})`);
  console.log(
    `  extension: ${before.extensionEnabled ? 'on' : 'off'} -> ${args.off ? 'off' : 'on'}`,
  );
  if (args.blocked.length) {
    console.log(
      `  blocked sites: ${(before.blockedDomains ?? []).join(', ') || 'none'} -> ${args.blocked.join(', ')}`,
    );
  }
  if (!args.apply) {
    console.log('Dry run. Pass --apply to change it.');
    return;
  }
  await runAsSystem(() =>
    Institution.updateOne(
      { tenantId: args.tenantId },
      {
        $set: {
          'browserControl.extensionEnabled': !args.off,
          ...(args.blocked.length ? { 'browserControl.blockedDomains': args.blocked } : {}),
        },
      },
    ).exec(),
  );
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
