const path = require('path');
const { logger, runAsSystem } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const models = require('~/db/models');

/**
 * The seeded collections whose unique index failed to build because rows were seeded twice.
 * `refs` are the fields elsewhere that point at a row's `_id`, and so must follow the copy kept.
 */
const TARGETS = [
  { model: 'Role', keys: ['name', 'tenantId'], refs: [] },
  {
    model: 'AccessRole',
    keys: ['accessRoleId', 'tenantId'],
    refs: [{ model: 'AclEntry', field: 'roleId' }],
  },
  { model: 'AgentCategory', keys: ['value', 'tenantId'], refs: [] },
];

/** Bookkeeping fields, which copies of the same row always differ in. */
const IGNORED_FIELDS = ['_id', '__v', 'createdAt', 'updatedAt'];

/**
 * Fields whose values differ between the kept row and a copy. The unique key's own fields are
 * equal within a group by definition, even where one copy stores `null` and the other omits it.
 */
function differingFields(kept, copy, keys = []) {
  const ignored = new Set([...IGNORED_FIELDS, ...keys]);
  const fields = new Set([...Object.keys(kept), ...Object.keys(copy)]);
  return [...fields].filter(
    (field) => !ignored.has(field) && JSON.stringify(kept[field]) !== JSON.stringify(copy[field]),
  );
}

/** Rows sharing one unique key. `tenantId: null` also matches rows without one, as the index does. */
async function findDuplicateGroups(Model, keys) {
  const groups = await Model.aggregate([
    {
      $group: {
        /** `$ifNull` folds missing into null: the group key must match the unique index's. */
        _id: Object.fromEntries(keys.map((key) => [key, { $ifNull: [`$${key}`, null] }])),
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  return groups.map((group) =>
    Object.fromEntries(keys.map((key) => [key, group._id[key] ?? null])),
  );
}

/**
 * Plans one group: keep the row the app reads today (`findOne` on the same key, with no sort,
 * as the app's lookups do), so behaviour does not change; remove the rest.
 */
async function planGroup(Model, filter, keys) {
  const kept = await Model.findOne(filter).lean();
  const rows = await Model.find(filter).lean();
  const copies = rows.filter((row) => String(row._id) !== String(kept._id));
  const differences = copies
    .map((copy) => ({ _id: String(copy._id), fields: differingFields(kept, copy, keys) }))
    .filter((difference) => difference.fields.length > 0);
  return { filter, kept: String(kept._id), removed: copies.map((copy) => copy._id), differences };
}

async function repairTarget(target, { apply }) {
  const Model = models[target.model];
  const filters = await findDuplicateGroups(Model, target.keys);
  const plans = [];
  for (const filter of filters) {
    plans.push(await planGroup(Model, filter, target.keys));
  }
  const result = {
    model: target.model,
    groups: plans.length,
    removed: plans.reduce((sum, plan) => sum + plan.removed.length, 0),
    differing: plans.filter((plan) => plan.differences.length > 0),
    repointed: {},
    indexBuilt: false,
  };
  if (!apply) {
    for (const ref of target.refs) {
      const ids = plans.flatMap((plan) => plan.removed);
      result.repointed[`${ref.model}.${ref.field}`] = await models[ref.model].countDocuments({
        [ref.field]: { $in: ids },
      });
    }
    return result;
  }

  for (const plan of plans) {
    for (const ref of target.refs) {
      const { modifiedCount } = await models[ref.model].updateMany(
        { [ref.field]: { $in: plan.removed } },
        { $set: { [ref.field]: plan.kept } },
      );
      const label = `${ref.model}.${ref.field}`;
      result.repointed[label] = (result.repointed[label] ?? 0) + modifiedCount;
    }
    await Model.deleteMany({ _id: { $in: plan.removed } });
  }
  /** Targeted createIndex, not syncIndexes, which would also drop indexes the schema lacks. */
  await Model.collection.createIndex(Object.fromEntries(target.keys.map((key) => [key, 1])), {
    unique: true,
    background: true,
  });
  result.indexBuilt = true;
  return result;
}

/**
 * Removes rows seeded twice into Role, AccessRole and AgentCategory, then builds the unique
 * indexes that should have stopped it. Without them, the app logs "Index build failed ... E11000
 * duplicate key" on every start, and nothing stops the next seed run from adding more copies.
 *
 * The copy kept is the one the app already reads, references to the others are repointed to it,
 * and the rest are deleted. Dry run by default. If copies of a row differ in content, `--apply`
 * stops unless `--allow-differences` is given, so a role with diverging permissions is reviewed
 * first. Safe to re-run: once every key is unique, nothing is written.
 *
 * Usage:
 *   node config/repair-duplicate-seeds.js                              # report only
 *   node config/repair-duplicate-seeds.js --apply                      # repair and build indexes
 *   node config/repair-duplicate-seeds.js --apply --allow-differences  # also where copies differ
 *
 * @param {{ apply?: boolean, allowDifferences?: boolean }} [options]
 */
async function repairDuplicateSeeds({ apply = false, allowDifferences = false } = {}) {
  await connect();
  return runAsSystem(async () => {
    const preview = [];
    for (const target of TARGETS) {
      preview.push(await repairTarget(target, { apply: false }));
    }
    const differing = preview.flatMap((result) => result.differing);
    if (!apply) {
      return { applied: false, results: preview };
    }
    if (differing.length > 0 && !allowDifferences) {
      return { applied: false, blocked: true, results: preview };
    }
    const results = [];
    for (const target of TARGETS) {
      results.push(await repairTarget(target, { apply: true }));
    }
    logger.info('[repair-duplicate-seeds] repaired', {
      results: results.map(({ model, groups, removed, indexBuilt }) => ({
        model,
        groups,
        removed,
        indexBuilt,
      })),
    });
    return { applied: true, results };
  });
}

function printResults({ applied, blocked, results }) {
  console.log(`\n=== ${applied ? 'REPAIRED' : 'DRY RUN'} ===`);
  for (const result of results) {
    const refs = Object.entries(result.repointed)
      .map(([label, count]) => `${label} ${applied ? 'repointed' : 'to repoint'}: ${count}`)
      .join(', ');
    console.log(
      `${result.model}: ${result.groups} duplicated key(s), ${result.removed} row(s) ${applied ? 'removed' : 'to remove'}` +
        (refs ? `, ${refs}` : '') +
        (applied ? `, unique index ${result.indexBuilt ? 'built' : 'NOT built'}` : ''),
    );
    for (const plan of result.differing) {
      console.log(
        `  differs: ${JSON.stringify(plan.filter)} keeps ${plan.kept}; ` +
          plan.differences.map((d) => `${d._id} differs in ${d.fields.join(', ')}`).join('; '),
      );
    }
  }
  if (blocked) {
    console.log(
      '\nNot applied: some copies differ (listed above). Review them, then re-run with ' +
        '--apply --allow-differences to keep the copy the app reads today.',
    );
  } else if (!applied) {
    console.log('\nDry run only. Re-run with --apply to repair and build the unique indexes.');
  }
}

if (require.main === module) {
  repairDuplicateSeeds({
    apply: process.argv.includes('--apply'),
    allowDifferences: process.argv.includes('--allow-differences'),
  })
    .then((outcome) => {
      printResults(outcome);
      process.exit(outcome.blocked ? 2 : 0);
    })
    .catch((error) => {
      console.error('Duplicate seed repair failed:', error);
      process.exit(1);
    });
}

module.exports = { repairDuplicateSeeds, differingFields };
