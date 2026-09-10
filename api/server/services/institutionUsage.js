const mongoose = require('mongoose');
const { resolveModelLabel } = require('@librechat/api');
const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { getCalendarMonthRange, zonedDateTimeToUtc } = require('./usageQuota');
const models = require('~/db/models');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseDateBoundary(value, label, timeZone) {
  if (value == null || value === '') {
    return null;
  }

  // Date inputs submit YYYY-MM-DD. Treat the end date as inclusive and
  // resolve both boundaries in the institution timezone instead of UTC.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    const date = zonedDateTimeToUtc(
      {
        year,
        month,
        day: label === 'end' ? day + 1 : day,
      },
      timeZone,
    );
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, `Invalid ${label} date`);
    }
    return date;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `Invalid ${label} date`);
  }
  return parsed;
}

async function resolveRange(tenantId, { start, end } = {}) {
  let timezone = 'UTC';
  if (tenantId) {
    const institution = await runAsSystem(() =>
      models.Institution.findOne({ tenantId }).select('timezone').lean().exec(),
    );
    if (!institution) {
      throw new HttpError(404, 'Institution not found');
    }
    timezone = institution.timezone;
  }
  const defaults = getCalendarMonthRange(timezone);
  const startDate = parseDateBoundary(start, 'start', timezone) ?? defaults.start;
  const endDate = parseDateBoundary(end, 'end', timezone) ?? defaults.end;

  if (startDate >= endDate) {
    throw new HttpError(400, 'The start date must be earlier than the end date');
  }

  return { start: startDate, end: endDate, timezone: defaults.timezone };
}

function parsePagination({ limit, offset } = {}) {
  const parsedLimit = Number.parseInt(String(limit ?? '25'), 10);
  const parsedOffset = Number.parseInt(String(offset ?? '0'), 10);
  return {
    limit: Math.min(Math.max(Number.isNaN(parsedLimit) ? 25 : parsedLimit, 1), 100),
    offset: Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function csvCell(value) {
  if (value == null) {
    return '';
  }
  const normalized = String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function getTransactionModel() {
  return mongoose.models.Transaction;
}

function getBaseMatch(range) {
  return {
    createdAt: {
      $gte: range.start,
      $lt: range.end,
    },
    tokenType: { $in: ['prompt', 'completion'] },
    $or: [{ usageUnit: { $exists: false } }, { usageUnit: 'tokens' }],
  };
}

/**
 * Canonical provider for a ledger row, resolved in the pipeline.
 *
 * Rows written before provider attribution was mandatory carry no
 * `providerKey`, and older ones carry mixed casing ("openAI" vs "openai").
 * Grouping on the raw field splits one model across several rows and labels
 * half of them "unknown", so it is normalized on read rather than requiring a
 * backfill of historical usage.
 */
function providerKeyExpr() {
  const model = { $toLower: { $ifNull: ['$providerModelId', { $ifNull: ['$model', ''] }] } };
  return {
    $let: {
      vars: {
        declared: { $toLower: { $trim: { input: { $ifNull: ['$providerKey', ''] } } } },
        model,
      },
      in: {
        $switch: {
          branches: [
            { case: { $ne: ['$$declared', ''] }, then: '$$declared' },
            {
              case: {
                $regexMatch: { input: '$$model', regex: '^(gpt-|o1|o3|o4|chat-latest)' },
              },
              then: 'openai',
            },
            { case: { $regexMatch: { input: '$$model', regex: '^claude-' } }, then: 'anthropic' },
            {
              case: { $regexMatch: { input: '$$model', regex: '^(gemini|gemma)' } },
              then: 'google',
            },
            { case: { $regexMatch: { input: '$$model', regex: '^grok-' } }, then: 'xai' },
          ],
          default: 'unknown',
        },
      },
    },
  };
}

/**
 * The model as the operator recognises it. `modelKey` is a pricing bucket and
 * can be coarser than reality (gpt-5.6-luna prices as gpt-5), which reads as a
 * phantom model in a usage report.
 */
function modelIdExpr() {
  return { $ifNull: ['$providerModelId', { $ifNull: ['$model', 'unknown'] }] };
}

/**
 * The modelSpec the member actually picked, recorded on the conversation. It is
 * the only way back to the label the chat UI showed: several specs can share
 * one provider model (the office agent and the Claude spec both run
 * `claude-haiku-4-5`), so the model id alone cannot tell them apart.
 */
function conversationSpecLookup() {
  return {
    $lookup: {
      from: 'conversations',
      let: { conversationId: '$_id.conversationId' },
      pipeline: [
        { $match: { $expr: { $eq: ['$conversationId', '$$conversationId'] } } },
        { $project: { _id: 0, spec: 1 } },
        { $limit: 1 },
      ],
      as: 'conversation',
    },
  };
}

function mergeModelUsageRows(rows, { index, restrictToLabeled } = {}) {
  const merged = new Map();

  for (const row of rows) {
    const displayName = index
      ? resolveModelLabel(index, { specName: row.spec, modelId: row.modelKey })
      : undefined;

    if (restrictToLabeled && !displayName) {
      continue;
    }

    const key = displayName ?? `${row.providerKey ?? 'unknown'}:${row.modelKey}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        displayName,
        providerKey: row.providerKey,
        modelKey: row.modelKey,
        providerModelId: row.modelKey,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.promptTokens + row.completionTokens,
        totalCost: row.totalCost,
        eventCount: row.eventCount,
        lastUsedAt: row.lastUsedAt,
        memberIds: new Set(row.memberIds),
      });
      continue;
    }

    existing.promptTokens += row.promptTokens;
    existing.completionTokens += row.completionTokens;
    existing.totalTokens += row.promptTokens + row.completionTokens;
    existing.totalCost += row.totalCost;
    existing.eventCount += row.eventCount;
    if (row.lastUsedAt > existing.lastUsedAt) {
      existing.lastUsedAt = row.lastUsedAt;
    }
    for (const memberId of row.memberIds) {
      existing.memberIds.add(memberId);
    }
  }

  return Array.from(merged.values())
    .map(({ memberIds, ...row }) => ({ ...row, memberCount: memberIds.size }))
    .sort((a, b) => b.totalTokens - a.totalTokens || String(a.modelKey).localeCompare(b.modelKey));
}

function stripRestrictedFields(row, restrictToLabeled) {
  if (!restrictToLabeled) {
    return row;
  }
  const {
    totalCost: _totalCost,
    providerKey: _providerKey,
    providerModelId: _providerModelId,
    ...visible
  } = row;
  return visible;
}

function getTokenProjection() {
  return {
    promptTokens: {
      $sum: {
        $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
      },
    },
    completionTokens: {
      $sum: {
        $cond: [{ $eq: ['$tokenType', 'completion'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
      },
    },
    totalCost: {
      $sum: { $abs: { $ifNull: ['$tokenValue', 0] } },
    },
    lastUsedAt: { $max: '$createdAt' },
    eventCount: { $sum: 1 },
  };
}

async function getUsageSummary({ tenantId, start, end, labels }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();
  const restrictToLabeled = labels?.restrictToLabeled === true;

  /** "Models used" counts the same rows the model table shows, so the card and
   *  the table can never disagree for either audience. */
  const [[summary], models] = await Promise.all([
    tenantStorage.run({ tenantId }, async () =>
      Transaction.aggregate([
        { $match: getBaseMatch(range) },
        {
          $group: {
            _id: null,
            ...getTokenProjection(),
            members: { $addToSet: '$user' },
          },
        },
        {
          $project: {
            _id: 0,
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
            totalCost: 1,
            eventCount: 1,
            memberCount: { $size: '$members' },
          },
        },
      ]),
    ),
    aggregateModelUsage({ tenantId, range, labels }),
  ]);

  const resolved = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    eventCount: 0,
    memberCount: 0,
    ...(summary ?? {}),
    modelCount: models.length,
  };

  return { range, summary: stripRestrictedFields(resolved, restrictToLabeled) };
}

async function listUsageByMember({ tenantId, start, end, limit, offset, query, labels }) {
  const range = await resolveRange(tenantId, { start, end });
  const pagination = parsePagination({ limit, offset });
  const Transaction = getTransactionModel();
  const search = typeof query === 'string' && query.trim() ? query.trim() : null;
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;

  const [result] = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: '$user',
          ...getTokenProjection(),
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      ...(regex
        ? [
            {
              $match: {
                $or: [{ 'user.name': regex }, { 'user.email': regex }, { 'user.username': regex }],
              },
            },
          ]
        : []),
      {
        $project: {
          _id: 0,
          userId: { $toString: '$_id' },
          name: { $ifNull: ['$user.name', 'Unknown member'] },
          email: '$user.email',
          role: '$user.role',
          membershipStatus: '$user.membershipStatus',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
          lastUsedAt: 1,
        },
      },
      { $sort: { totalTokens: -1, name: 1 } },
      {
        $facet: {
          rows: [{ $skip: pagination.offset }, { $limit: pagination.limit }],
          meta: [{ $count: 'total' }],
        },
      },
    ]),
  );

  const total = result?.meta?.[0]?.total ?? 0;
  const restrictToLabeled = labels?.restrictToLabeled === true;

  return {
    range,
    members: (result?.rows ?? []).map((row) => stripRestrictedFields(row, restrictToLabeled)),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

/**
 * Usage per model, keyed by the label the chat UI shows. Grouping is done in
 * two stages: per conversation first, so the spec lookup runs once per
 * conversation rather than once per ledger row, then per (spec, model) pair —
 * a set small enough to label, merge and page in memory.
 *
 * The billing view drops models that used tokens but cost nothing, from both
 * the table and the "Models used" card. Institution admins never see cost, so
 * their view keeps every labeled model's usage.
 */
async function aggregateModelUsage({ tenantId, range, labels }) {
  const Transaction = getTransactionModel();

  const rows = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate(
      [
        { $match: getBaseMatch(range) },
        {
          $group: {
            _id: {
              conversationId: '$conversationId',
              modelKey: modelIdExpr(),
              providerKey: providerKeyExpr(),
            },
            ...getTokenProjection(),
            memberIds: { $addToSet: '$user' },
          },
        },
        conversationSpecLookup(),
        {
          $group: {
            _id: {
              spec: { $first: '$conversation.spec' },
              modelKey: '$_id.modelKey',
              providerKey: '$_id.providerKey',
            },
            promptTokens: { $sum: '$promptTokens' },
            completionTokens: { $sum: '$completionTokens' },
            totalCost: { $sum: '$totalCost' },
            eventCount: { $sum: '$eventCount' },
            lastUsedAt: { $max: '$lastUsedAt' },
            memberIdGroups: { $push: '$memberIds' },
          },
        },
        {
          $project: {
            _id: 0,
            spec: '$_id.spec',
            modelKey: { $ifNull: ['$_id.modelKey', 'unknown'] },
            providerKey: '$_id.providerKey',
            promptTokens: 1,
            completionTokens: 1,
            totalCost: 1,
            eventCount: 1,
            lastUsedAt: 1,
            memberIds: {
              $reduce: {
                input: '$memberIdGroups',
                initialValue: [],
                in: { $setUnion: ['$$value', '$$this'] },
              },
            },
          },
        },
      ],
      { allowDiskUse: true },
    ),
  );

  const merged = mergeModelUsageRows(rows, labels);
  if (labels?.restrictToLabeled === true) {
    return merged;
  }
  return merged.filter((row) => row.totalCost > 0);
}

async function listUsageByModel({ tenantId, start, end, limit, offset, query, labels }) {
  const range = await resolveRange(tenantId, { start, end });
  const pagination = parsePagination({ limit, offset });
  const merged = await aggregateModelUsage({ tenantId, range, labels });

  const search = typeof query === 'string' && query.trim() ? query.trim() : null;
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;
  const matched = regex
    ? merged.filter(
        (row) =>
          regex.test(row.displayName ?? '') ||
          regex.test(row.modelKey ?? '') ||
          regex.test(row.providerKey ?? ''),
      )
    : merged;

  const restrictToLabeled = labels?.restrictToLabeled === true;

  return {
    range,
    models: matched
      .slice(pagination.offset, pagination.offset + pagination.limit)
      .map((row) => stripRestrictedFields(row, restrictToLabeled)),
    total: matched.length,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

async function getUsageTimeseries({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const points = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: range.timezone,
              },
            },
          },
          ...getTokenProjection(),
        },
      },
      {
        $project: {
          _id: 0,
          day: '$_id.day',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
        },
      },
      { $sort: { day: 1 } },
    ]),
  );

  return { range, points };
}

async function exportUsageCsv({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const rows = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 0,
          createdAt: 1,
          conversationId: 1,
          messageId: 1,
          requestKey: 1,
          userId: { $toString: '$user._id' },
          memberName: '$user.name',
          memberEmail: '$user.email',
          memberRole: '$user.role',
          membershipStatus: '$user.membershipStatus',
          providerKey: providerKeyExpr(),
          modelKey: modelIdExpr(),
          providerModelId: modelIdExpr(),
          tokenType: 1,
          promptTokens: {
            $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
          },
          completionTokens: {
            $cond: [
              { $eq: ['$tokenType', 'completion'] },
              { $abs: { $ifNull: ['$rawAmount', 0] } },
              0,
            ],
          },
          rawAmount: '$rawAmount',
          tokenValue: '$tokenValue',
          usageKind: { $ifNull: ['$usageKind', '$context'] },
        },
      },
      { $sort: { createdAt: 1, requestKey: 1, tokenType: 1 } },
    ]),
  );

  const lines = [
    [
      'createdAt',
      'conversationId',
      'messageId',
      'requestKey',
      'userId',
      'memberName',
      'memberEmail',
      'memberRole',
      'membershipStatus',
      'providerKey',
      'modelKey',
      'providerModelId',
      'tokenType',
      'promptTokens',
      'completionTokens',
      'rawAmount',
      'tokenValue',
      'usageKind',
    ].join(','),
    ...rows.map((row) =>
      [
        row.createdAt?.toISOString?.() ?? row.createdAt,
        row.conversationId,
        row.messageId,
        row.requestKey,
        row.userId,
        row.memberName,
        row.memberEmail,
        row.memberRole,
        row.membershipStatus,
        row.providerKey,
        row.modelKey,
        row.providerModelId,
        row.tokenType,
        row.promptTokens,
        row.completionTokens,
        row.rawAmount,
        row.tokenValue,
        row.usageKind,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];

  return {
    range,
    csv: `${lines.join('\n')}\n`,
  };
}

async function getMemberUsageSummary({ tenantId, userId, start, end, labels }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();
  const objectId = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;
  const memberMatch = { ...getBaseMatch(range), user: objectId };
  const aggregate = () =>
    Promise.all([
      Transaction.aggregate([
        { $match: memberMatch },
        { $group: { _id: null, ...getTokenProjection() } },
        {
          $project: {
            _id: 0,
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
            totalCost: 1,
            eventCount: 1,
            lastUsedAt: 1,
          },
        },
      ]),
      /** Same identity rules as the institution-wide model table: the operator's
       *  model id, not the coarser pricing bucket, attributed by spec. */
      Transaction.aggregate(
        [
          { $match: memberMatch },
          {
            $group: {
              _id: {
                conversationId: '$conversationId',
                modelKey: modelIdExpr(),
                providerKey: providerKeyExpr(),
              },
              ...getTokenProjection(),
              memberIds: { $addToSet: '$user' },
            },
          },
          conversationSpecLookup(),
          {
            $group: {
              _id: {
                spec: { $first: '$conversation.spec' },
                modelKey: '$_id.modelKey',
                providerKey: '$_id.providerKey',
              },
              promptTokens: { $sum: '$promptTokens' },
              completionTokens: { $sum: '$completionTokens' },
              totalCost: { $sum: '$totalCost' },
              eventCount: { $sum: '$eventCount' },
              lastUsedAt: { $max: '$lastUsedAt' },
              memberIdGroups: { $push: '$memberIds' },
            },
          },
          {
            $project: {
              _id: 0,
              spec: '$_id.spec',
              modelKey: { $ifNull: ['$_id.modelKey', 'unknown'] },
              providerKey: '$_id.providerKey',
              promptTokens: 1,
              completionTokens: 1,
              totalCost: 1,
              eventCount: 1,
              lastUsedAt: 1,
              memberIds: {
                $reduce: {
                  input: '$memberIdGroups',
                  initialValue: [],
                  in: { $setUnion: ['$$value', '$$this'] },
                },
              },
            },
          },
        ],
        { allowDiskUse: true },
      ),
    ]);
  const [summary, modelRows] = tenantId
    ? await tenantStorage.run({ tenantId }, aggregate)
    : await runAsSystem(aggregate);

  const restrictToLabeled = labels?.restrictToLabeled === true;
  const resolved = summary[0] ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    eventCount: 0,
    lastUsedAt: null,
  };

  return {
    range,
    summary: stripRestrictedFields(resolved, restrictToLabeled),
    models: mergeModelUsageRows(modelRows, labels).map(({ memberCount: _memberCount, ...row }) =>
      stripRestrictedFields(row, restrictToLabeled),
    ),
  };
}

module.exports = {
  HttpError,
  exportUsageCsv,
  getMemberUsageSummary,
  getUsageSummary,
  getUsageTimeseries,
  listUsageByMember,
  listUsageByModel,
};
