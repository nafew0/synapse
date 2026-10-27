const mongoose = require('mongoose');
const { resolveModelLabel, bareModelId } = require('@librechat/api');
const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { getCalendarMonthRange, zonedDateTimeToUtc } = require('./usageQuota');
const XLSX = require('xlsx');
const models = require('~/db/models');
const { resolveMemberRole } = require('./accountRoles');
const { visibleMembershipFilter } = require('./institutionMembers');

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

/** The single row superadmins see for every model no longer in `librechat.yaml`. */
const RETIRED_MODELS = { key: 'retired', label: 'Retired models' };

/** Grouping for one ledger row: its UI label, all retired models together, or (with
 *  no label index at all) the model id without its provider prefix. */
function modelGroup(row, index) {
  if (!index) {
    return { key: bareModelId(row.modelKey) || 'unknown', displayName: undefined, retired: false };
  }
  const displayName = resolveModelLabel(index, { specName: row.spec, modelId: row.modelKey });
  if (displayName) {
    return { key: displayName, displayName, retired: false };
  }
  return { key: RETIRED_MODELS.key, displayName: RETIRED_MODELS.label, retired: true };
}

function mergeModelUsageRows(rows, { index, restrictToLabeled } = {}) {
  const merged = new Map();

  for (const row of rows) {
    const { key, displayName, retired } = modelGroup(row, index);

    if (restrictToLabeled && retired) {
      continue;
    }

    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        displayName,
        ...(retired
          ? { retired: true, retiredModelIds: new Set([bareModelId(row.modelKey)]) }
          : {}),
        providerKey: retired ? undefined : row.providerKey,
        modelKey: retired ? RETIRED_MODELS.key : row.modelKey,
        providerModelId: retired ? undefined : row.modelKey,
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
    existing.retiredModelIds?.add(bareModelId(row.modelKey));
  }

  return Array.from(merged.values())
    .map(({ memberIds, retiredModelIds, ...row }) => ({
      ...row,
      ...(retiredModelIds ? { retiredModelIds: Array.from(retiredModelIds).sort() } : {}),
      memberCount: memberIds.size,
    }))
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

  /** "Models used" counts the models members can pick today: the table's rows,
   *  less the one row superadmins see for retired models. */
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
    modelCount: models.filter((row) => !row.retired).length,
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
          regex.test(row.providerKey ?? '') ||
          (row.retiredModelIds ?? []).some((id) => regex.test(id)),
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

/**
 * A spreadsheet cell, quoted for CSV and defused for spreadsheet apps: a value
 * opening with = + - @ (or a tab/CR) is read as a formula by Excel and Sheets,
 * and member names are user-supplied.
 */
function sheetCell(value) {
  if (value == null) {
    return '';
  }
  const text = String(value);
  return csvCell(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

const MEMBER_USAGE_HEADER = ['User ID', 'Account created at', 'Name', 'Role', 'Total Used Tokens'];

function trimDecimals(value, digits) {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Token totals as an admin reads them: millions from 0.1M up (0.1M, 0.41M,
 * 1.25M), thousands from 1K up to that (1K, 99.5K), the plain count below.
 * A value that rounds to 100K is shown as 0.1M rather than "100K".
 */
function formatTokenCount(tokens) {
  const thousands = Number((tokens / 1_000).toFixed(1));
  if (thousands >= 100) {
    return `${trimDecimals(tokens / 1_000_000, 2)}M`;
  }
  if (tokens >= 1_000) {
    return `${trimDecimals(thousands, 1)}K`;
  }
  return String(Math.round(tokens));
}

/**
 * The institution admin's usage export: one row per member who can sign in
 * (active or suspended, as the members list shows them), with their total
 * tokens in the range — zero for members who used nothing. Busiest first.
 * Account creation is shown in the institution's own timezone.
 */
async function exportMemberUsageCsv({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const [users, totals] = await tenantStorage.run({ tenantId }, () =>
    Promise.all([
      models.User.find({ tenantId, ...visibleMembershipFilter() })
        .select('_id name email role tenantId accountScope createdAt')
        .lean()
        .exec(),
      Transaction.aggregate([
        { $match: getBaseMatch(range) },
        {
          $group: {
            _id: '$user',
            totalTokens: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
          },
        },
      ]),
    ]),
  );

  const tokensByUser = new Map(totals.map((row) => [String(row._id), row.totalTokens]));
  const rows = users
    .map((user) => ({
      userId: String(user._id),
      name: user.name || user.email || '',
      role: resolveMemberRole(user) === 'INSTITUTION_ADMIN' ? 'Institution admin' : 'Member',
      totalTokens: tokensByUser.get(String(user._id)) ?? 0,
      createdAt: formatLocalDateTime(user.createdAt, range.timezone),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));

  const lines = [
    MEMBER_USAGE_HEADER.map(sheetCell).join(','),
    ...rows.map((row) =>
      [row.userId, row.createdAt, row.name, row.role, formatTokenCount(row.totalTokens)]
        .map(sheetCell)
        .join(','),
    ),
  ];

  return { range, csv: `${lines.join('\n')}\n` };
}

/** Tokens display as 0.28M from 100K up, 78.0K from 1K up, plain below; the cell keeps the exact count. */
const TOKEN_FORMAT = '[>=99950]0.0#,,"M";[>=1000]0.0,"K";0';
const RETIRED_COLUMN = 'Other (retired models)';
const MEMBER_COLUMNS = ['User ID', 'Account created at', 'Name', 'Email', 'Role'];
/** The member table starts below the summary block; its header is this sheet row (1-based). */
const MEMBER_HEADER_ROW = 9;

function localParts(value, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
}

function formatLocalDate(value, timeZone) {
  const parts = localParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatLocalDateTime(value, timeZone) {
  if (!value) {
    return '';
  }
  const parts = localParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Each member's tokens per model label, plus the model columns ordered by overall use. */
async function aggregateMemberModelTokens({ tenantId, range, labels }) {
  const Transaction = getTransactionModel();
  const rows = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate(
      [
        { $match: getBaseMatch(range) },
        {
          $group: {
            _id: { user: '$user', conversationId: '$conversationId', modelKey: modelIdExpr() },
            tokens: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
          },
        },
        conversationSpecLookup(),
        {
          $project: {
            _id: 0,
            user: '$_id.user',
            modelKey: '$_id.modelKey',
            spec: { $first: '$conversation.spec' },
            tokens: 1,
          },
        },
      ],
      { allowDiskUse: true },
    ),
  );

  const byMember = new Map();
  const byModel = new Map();
  for (const row of rows) {
    const label =
      (labels?.index &&
        resolveModelLabel(labels.index, { specName: row.spec, modelId: row.modelKey })) ||
      RETIRED_COLUMN;
    const memberId = String(row.user);
    const tokens = byMember.get(memberId) ?? new Map();
    tokens.set(label, (tokens.get(label) ?? 0) + row.tokens);
    byMember.set(memberId, tokens);
    byModel.set(label, (byModel.get(label) ?? 0) + row.tokens);
  }

  const columns = [...byModel.keys()]
    .filter((label) => label !== RETIRED_COLUMN)
    .sort((a, b) => byModel.get(b) - byModel.get(a));
  if (byModel.has(RETIRED_COLUMN)) {
    columns.push(RETIRED_COLUMN);
  }
  return { byMember, byModel, columns };
}

/**
 * The superadmin's usage export for one institution, as a workbook: a summary
 * block (institution, period, member counts, total tokens) above one row per
 * member who can sign in, with their tokens per model and a total. Totals and
 * counts are Excel formulas over the rows, so they follow any edit; token cells
 * hold exact counts and only display as K/M.
 */
async function exportMemberUsageWorkbook({ tenantId, start, end, labels, now = new Date() }) {
  const range = await resolveRange(tenantId, { start, end });
  const [institution, users, usage] = await Promise.all([
    runAsSystem(() => models.Institution.findOne({ tenantId }).select('name').lean().exec()),
    tenantStorage.run({ tenantId }, () =>
      models.User.find({ tenantId, ...visibleMembershipFilter() })
        .select('_id name email role tenantId accountScope createdAt')
        .lean()
        .exec(),
    ),
    aggregateMemberModelTokens({ tenantId, range, labels }),
  ]);

  const { byMember } = usage;
  const members = users
    .map((user) => {
      const tokens = byMember.get(String(user._id)) ?? new Map();
      let total = 0;
      for (const value of tokens.values()) {
        total += value;
      }
      return { user, tokens, total, name: user.name || user.email || '' };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  /** Only models a listed member used: usage by removed members leaves no empty column. */
  const columns = usage.columns.filter((label) =>
    members.some((member) => member.tokens.has(label)),
  );

  const first = MEMBER_HEADER_ROW + 1;
  const last = Math.max(MEMBER_HEADER_ROW + members.length, first);
  const totalCol = MEMBER_COLUMNS.length + columns.length;
  const col = (index) => XLSX.utils.encode_col(index);
  const totalRange = `${col(totalCol)}${first}:${col(totalCol)}${last}`;
  const grandTotal = members.reduce((sum, member) => sum + member.total, 0);
  /** Column totals over the listed members only, matching the SUM formulas below them. */
  const columnTotal = (label) =>
    members.reduce((sum, member) => sum + (member.tokens.get(label) ?? 0), 0);
  const lastDay = new Date(range.end.getTime() - 1);

  const sheet = XLSX.utils.aoa_to_sheet([
    ['Member usage report'],
    ['Institution', institution?.name ?? tenantId],
    [
      'Period',
      `${formatLocalDate(range.start, range.timezone)} to ${formatLocalDate(lastDay, range.timezone)} (${range.timezone})`,
    ],
    ['Total members'],
    ['Active members'],
    ['Total used tokens'],
    ['Exported at', formatLocalDateTime(now, range.timezone)],
    [],
    [...MEMBER_COLUMNS, ...columns, 'Total Used Tokens'],
  ]);
  sheet.B4 = { t: 'n', f: `COUNTA(C${first}:C${last})`, v: members.length };
  sheet.B5 = {
    t: 'n',
    f: `COUNTIF(${totalRange},">0")`,
    v: members.filter((member) => member.total > 0).length,
  };
  sheet.B6 = { t: 'n', f: `SUM(${totalRange})`, v: grandTotal, z: TOKEN_FORMAT };

  members.forEach((member, index) => {
    const row = first + index;
    const cells = [
      String(member.user._id),
      formatLocalDateTime(member.user.createdAt, range.timezone),
      member.name,
      member.user.email ?? '',
      resolveMemberRole(member.user) === 'INSTITUTION_ADMIN' ? 'Institution admin' : 'Member',
    ];
    cells.forEach((value, c) => {
      sheet[`${col(c)}${row}`] = { t: 's', v: value };
    });
    columns.forEach((label, c) => {
      const value = member.tokens.get(label) ?? 0;
      sheet[`${col(MEMBER_COLUMNS.length + c)}${row}`] = { t: 'n', v: value, z: TOKEN_FORMAT };
    });
    sheet[`${col(totalCol)}${row}`] = {
      t: 'n',
      f: columns.length
        ? `SUM(${col(MEMBER_COLUMNS.length)}${row}:${col(totalCol - 1)}${row})`
        : '0',
      v: member.total,
      z: TOKEN_FORMAT,
    };
  });

  const sumRow = MEMBER_HEADER_ROW + members.length + 1;
  sheet[`A${sumRow}`] = { t: 's', v: 'Total' };
  for (let c = MEMBER_COLUMNS.length; c <= totalCol; c += 1) {
    const letter = col(c);
    sheet[`${letter}${sumRow}`] = {
      t: 'n',
      f: `SUM(${letter}${first}:${letter}${last})`,
      v: c === totalCol ? grandTotal : columnTotal(columns[c - MEMBER_COLUMNS.length]),
      z: TOKEN_FORMAT,
    };
  }

  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sumRow - 1, c: totalCol } });
  sheet['!cols'] = [
    { wch: 26 },
    { wch: 18 },
    { wch: 22 },
    { wch: 30 },
    { wch: 17 },
    ...columns.map((label) => ({ wch: Math.max(12, label.length + 2) })),
    { wch: 18 },
  ];
  sheet['!autofilter'] = { ref: `A${MEMBER_HEADER_ROW}:${col(totalCol)}${last}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Member usage');
  return { range, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
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
  exportMemberUsageWorkbook,
  exportMemberUsageCsv,
  getMemberUsageSummary,
  getUsageSummary,
  getUsageTimeseries,
  listUsageByMember,
  listUsageByModel,
};
