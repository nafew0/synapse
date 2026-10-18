const mongoose = require('mongoose');
const { getTransactionSupport, logger, runAsSystem } = require('@librechat/data-schemas');
const {
  unitFor,
  weightFor,
  usesCredits,
  matchModelName,
  estimateCredits,
  creditLimitCode,
  toBillingTokens,
  CREDITS_PER_USD,
  effectiveBdtPerUsd,
  checkEmailConfig,
  recordQuotaDenial,
  isEnforcementDenial,
  resolveCreditLimits,
  outputTokensForCredits,
  recordReservationExpiry,
} = require('@librechat/api');
const usageCatalog = require('./usageCatalog');
const models = require('~/db/models');
const { sendEmail } = require('~/server/utils');

const DEFAULT_TIMEZONE = 'Asia/Dhaka';
/**
 * Quota windows reset on the international standard, UTC — NOT the institution's
 * local timezone. Every tenant's week therefore turns over at the same instant
 * (Monday 00:00 UTC) and the reset time we show a user is unambiguous.
 *
 * `policy.timezone` still governs display and warning emails; it no longer moves
 * a bucket boundary.
 */
const QUOTA_RESET_TIMEZONE = 'UTC';
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
let transactionSupportCache = null;

class QuotaError extends Error {
  constructor(details) {
    const resolved = {
      code: 'TOKEN_QUOTA_EXCEEDED',
      ...details,
    };
    /**
     * The message is a JSON envelope, not prose, because that is the only way a
     * refusal survives the trip to the UI: `handleAbortError` forwards
     * `error.message` verbatim ONLY when it carries a `"type"`, and the client's
     * error renderer keys its localized copy off `type`/`code`. A plain string
     * here surfaced as "Something went wrong… Token quota exceeded", which told
     * the user nothing about when they could try again.
     *
     * Only display fields are included — never the institution's limits.
     */
    super(
      JSON.stringify({
        /**
         * `type` ONLY — deliberately no `code`. The client resolves its handler
         * as `json.code || json.type`, checking `code` FIRST, so shipping the
         * uppercase `TOKEN_QUOTA_EXCEEDED` alongside meant the lookup missed the
         * handler registered under the lowercase type and rendered raw JSON at
         * the user. The full code stays on `this.details` for logs and the API
         * body, where nothing keys off it by precedence.
         */
        type: 'token_quota_exceeded',
        limitCode: resolved.limitCode ?? null,
        window: resolved.window ?? null,
        meter: resolved.meter ?? null,
        resetAt: resolved.resetAt ?? null,
      }),
    );
    this.name = 'QuotaError';
    this.statusCode = 429;
    this.details = resolved;
    this.body = { error: this.details };
  }
}

/**
 * Which allowance ran out, so the UI can name it and the window it resets on.
 *
 * This is additive: `code` stays `TOKEN_QUOTA_EXCEEDED` because callers and
 * `FAIL_CLOSED_QUOTA_CODES` already branch on it, and a hard wall must keep
 * failing closed. `limitCode` narrows the same refusal for display.
 */
function resolveLimitCode(scopeType, window) {
  if (scopeType === 'member_images') {
    return window === 'week' ? 'IMAGE_WEEKLY_CAP' : 'IMAGE_MONTHLY_CAP';
  }
  if (scopeType === 'member') {
    return window === 'week' ? 'WEEKLY_CAP' : 'MONTHLY_CAP';
  }
  if (scopeType === 'model') {
    return 'MODEL_CAP';
  }
  return 'INSTITUTION_CAP';
}

function normalizeProviderKey(provider) {
  return String(provider || 'unknown')
    .trim()
    .toLowerCase();
}

function canonicalizeModel({ provider, model }) {
  const providerKey = normalizeProviderKey(provider);
  const rawModel = String(model || '').trim();
  const lowerModel = rawModel.toLowerCase();
  const prefix = `${providerKey}/`;
  const providerModelId = lowerModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
  const modelKey =
    matchModelName(providerModelId) || matchModelName(rawModel) || providerModelId.toLowerCase();
  return {
    providerKey,
    providerModelId,
    modelKey,
  };
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const correction = desired - represented;
    if (correction === 0) {
      break;
    }
    candidate = new Date(candidate.getTime() + correction);
  }
  return candidate;
}

function getCalendarMonthRange(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  let parts;
  try {
    parts = zonedParts(now, timeZone);
  } catch {
    throw new QuotaError({
      code: 'INVALID_INSTITUTION_TIMEZONE',
      scope: 'institution',
      timezone: timeZone,
    });
  }
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  return {
    timezone: timeZone,
    start: zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone),
    end: zonedDateTimeToUtc({ year: nextYear, month: nextMonth, day: 1 }, timeZone),
  };
}

/**
 * The weekly window resets in full at each boundary — no rollover, no carry-over.
 * A new week simply writes a new bucket (the unique index is keyed on
 * `periodStart`), so the reset needs no job and no mutation.
 *
 * ISO weeks: Monday 00:00 in the institution's timezone.
 */
function getCalendarWeekRange(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  let parts;
  try {
    parts = zonedParts(now, timeZone);
  } catch {
    throw new QuotaError({
      code: 'INVALID_INSTITUTION_TIMEZONE',
      scope: 'institution',
      timezone: timeZone,
    });
  }
  /** Weekday of the LOCAL calendar date, not of the UTC instant: east of UTC a
   *  local midnight falls on the previous UTC day, which would shift the week
   *  boundary by one day. `Date#getUTCDay` is Sunday-based; shift Monday to 0. */
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const isoDayIndex = (localDate.getUTCDay() + 6) % 7;
  const weekStartDate = new Date(localDate.getTime() - isoDayIndex * 24 * 60 * 60 * 1000);
  const weekEndDate = new Date(localDate.getTime() + (7 - isoDayIndex) * 24 * 60 * 60 * 1000);
  /** Both boundaries are resolved from calendar fields, so a DST transition
   *  inside the week moves the wall-clock offset without moving the boundary. */
  return {
    timezone: timeZone,
    start: zonedDateTimeToUtc(
      {
        year: weekStartDate.getUTCFullYear(),
        month: weekStartDate.getUTCMonth() + 1,
        day: weekStartDate.getUTCDate(),
      },
      timeZone,
    ),
    end: zonedDateTimeToUtc(
      {
        year: weekEndDate.getUTCFullYear(),
        month: weekEndDate.getUTCMonth() + 1,
        day: weekEndDate.getUTCDate(),
      },
      timeZone,
    ),
  };
}

/** Windows a policy enforces, each with the ranges scopes are bucketed into. */
function getPolicyRanges(policy, now = new Date()) {
  const periods = Array.isArray(policy.period)
    ? policy.period
    : [policy.period ?? 'calendar_month'];
  const month = getCalendarMonthRange(QUOTA_RESET_TIMEZONE, now);
  const week = periods.includes('calendar_week')
    ? getCalendarWeekRange(QUOTA_RESET_TIMEZONE, now)
    : null;
  return { month, week };
}

async function supportsTransactions() {
  const supported = await getTransactionSupport(mongoose, transactionSupportCache);
  transactionSupportCache = supported;
  return supported;
}

/** The institution (which carries its usage packages) and the policy it points at. */
async function loadQuotaContext(tenantId) {
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId }).lean().exec(),
  );
  if (!institution) {
    throw new QuotaError({
      code: 'INSTITUTION_NOT_FOUND',
      scope: 'institution',
      tenantId,
    });
  }

  const version = institution.usagePolicyVersion ?? 0;
  if (version < 1) {
    const policy = {
      tenantId,
      version: 0,
      mode: 'shadow',
      timezone: institution.timezone || DEFAULT_TIMEZONE,
      period: ['calendar_month'],
      limits: {
        institutionTokens: null,
        memberTokens: null,
        memberTokensWeekly: null,
        memberImages: null,
        memberImagesWeekly: null,
        modelTokens: [],
      },
      warningThresholds: [0.8, 0.9],
      inputSafetyFactor: 1.15,
      inputSafetyTokens: 256,
      effectiveAt: institution.createdAt || new Date(0),
    };
    return { institution, policy };
  }

  const policy = await runAsSystem(() =>
    models.UsagePolicy.findOne({ tenantId, version }).lean().exec(),
  );
  if (!policy) {
    throw new QuotaError({
      code: 'USAGE_POLICY_NOT_FOUND',
      scope: 'institution',
      tenantId,
      policyVersion: version,
    });
  }
  return { institution, policy };
}

async function getActivePolicy(tenantId) {
  return (await loadQuotaContext(tenantId)).policy;
}

/** Month and week windows. Credit scopes always enforce both, whatever the policy's `period`. */
function getCreditRanges(now = new Date()) {
  return {
    month: getCalendarMonthRange(QUOTA_RESET_TIMEZONE, now),
    week: getCalendarWeekRange(QUOTA_RESET_TIMEZONE, now),
  };
}

/** The four credit buckets a request draws from: the institution's and the member's, each per month and per week. */
function buildCreditScopes({ tenantId, userId, limits, ranges }) {
  const memberKey = String(userId);
  return [
    ['institution_credits', tenantId, limits.institution],
    ['member_credits', memberKey, limits.member],
  ].flatMap(([scopeType, scopeKey, windows]) => [
    { scopeType, scopeKey, limit: windows.month, range: ranges.month, window: 'month' },
    { scopeType, scopeKey, limit: windows.week, range: ranges.week, window: 'week' },
  ]);
}

function getModelLimit(policy, modelKey) {
  return (
    policy.limits?.modelTokens?.find((entry) => entry.modelKey === modelKey)?.maxTokens ?? null
  );
}

/**
 * Scopes reserved against for one request, each carrying the window it buckets
 * into. Buckets are keyed on `(tenantId, periodStart, scopeType, scopeKey)`, so
 * the same scope in the weekly and monthly window are distinct rows.
 *
 * A `null` limit records usage without ever denying — that is how an unlimited
 * override (superadmin) and shadow mode both stay fully observable.
 */
function buildScopes({ tenantId, userId, modelKey, policy, ranges, unit = 'tokens' }) {
  const memberKey = String(userId);
  /** Image endpoints are billed per image by the provider; metering their tokens
   *  would misprice them by orders of magnitude, so they use their own meter and
   *  never touch the token buckets. */
  if (unit === 'images') {
    const scopes = [
      {
        scopeType: 'member_images',
        scopeKey: memberKey,
        limit: policy.limits?.memberImages ?? null,
        range: ranges.month,
        window: 'month',
      },
    ];
    if (ranges.week) {
      scopes.push({
        scopeType: 'member_images',
        scopeKey: memberKey,
        limit: policy.limits?.memberImagesWeekly ?? null,
        range: ranges.week,
        window: 'week',
      });
    }
    return scopes;
  }

  const scopes = [
    {
      scopeType: 'institution',
      scopeKey: tenantId,
      limit: policy.limits?.institutionTokens ?? null,
      range: ranges.month,
      window: 'month',
    },
    {
      scopeType: 'member',
      scopeKey: memberKey,
      limit: policy.limits?.memberTokens ?? null,
      range: ranges.month,
      window: 'month',
    },
    {
      scopeType: 'model',
      scopeKey: modelKey,
      limit: getModelLimit(policy, modelKey),
      range: ranges.month,
      window: 'month',
    },
  ];
  if (ranges.week) {
    scopes.push({
      scopeType: 'member',
      scopeKey: memberKey,
      limit: policy.limits?.memberTokensWeekly ?? null,
      range: ranges.week,
      window: 'week',
    });
  }
  return scopes;
}

async function loadBucket({ tenantId, range, scope, policyVersion, session }) {
  const query = {
    tenantId,
    periodStart: range.start,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  };
  await models.UsageBucket.updateOne(
    query,
    {
      $setOnInsert: {
        ...query,
        periodEnd: range.end,
        policyVersion,
        usedTokens: 0,
        reservedTokens: 0,
      },
    },
    { upsert: true, session },
  ).exec();
  return query;
}

async function reserveBucket({ tenantId, range, scope, policyVersion, tokens, enforce, session }) {
  const query = await loadBucket({ tenantId, range, scope, policyVersion, session });
  const capacityFilter =
    enforce && scope.limit != null
      ? {
          $expr: {
            $lte: [
              {
                $add: [
                  { $ifNull: ['$usedTokens', 0] },
                  { $ifNull: ['$reservedTokens', 0] },
                  tokens,
                ],
              },
              scope.limit,
            ],
          },
        }
      : {};
  const bucket = await models.UsageBucket.findOneAndUpdate(
    { ...query, ...capacityFilter },
    {
      $inc: { reservedTokens: tokens },
      $set: { policyVersion, periodEnd: range.end },
    },
    { new: true, session },
  )
    .lean()
    .exec();

  if (bucket) {
    return {
      bucket,
      wouldDeny: scope.limit != null && bucket.usedTokens + bucket.reservedTokens > scope.limit,
    };
  }

  const current = await models.UsageBucket.findOne(query).session(session).lean().exec();
  const used = current?.usedTokens ?? 0;
  const reserved = current?.reservedTokens ?? 0;
  throw new QuotaError({
    scope: scope.scopeType,
    limitCode: resolveLimitCode(scope.scopeType, scope.window),
    window: scope.window ?? 'month',
    meter: scope.scopeType === 'member_images' ? 'images' : 'tokens',
    modelKey: scope.scopeType === 'model' ? scope.scopeKey : undefined,
    limit: scope.limit,
    used,
    reserved,
    remaining: Math.max((scope.limit ?? 0) - used - reserved, 0),
    resetAt: range.end.toISOString(),
  });
}

function conservativeInputTokens(policy, estimatedInputTokens) {
  return Math.ceil(
    Math.max(estimatedInputTokens, 0) * (policy.inputSafetyFactor ?? 1.15) +
      (policy.inputSafetyTokens ?? 256),
  );
}

/** Writes a reservation and holds its capacity in every scope, in one transaction where available. */
async function persistReservation({
  tenantId,
  reservationKey,
  doc,
  scopes,
  policy,
  tokens,
  transactionCapable,
}) {
  const session = transactionCapable ? await mongoose.startSession() : null;
  let result;
  let concurrentReplay = false;
  const execute = async () => {
    const reservation = await models.UsageReservation.create([doc], { session });
    result = reservation[0].toObject();
    for (const scope of scopes) {
      await reserveBucket({
        tenantId,
        range: scope.range,
        scope,
        policyVersion: Math.max(policy.version, 1),
        tokens,
        enforce: policy.mode === 'enforce',
        session,
      });
    }
  };

  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }
    const replay = await runAsSystem(() =>
      models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec(),
    );
    if (!replay) {
      throw error;
    }
    result = replay;
    concurrentReplay = true;
  } finally {
    if (session) {
      await session.endSession();
    }
  }
  return { result, concurrentReplay };
}

/** Remaining capacity of each limited scope, read before reserving so a refusal can name the binding window. */
async function readScopeRemaining(tenantId, scopes) {
  const limited = scopes.filter((scope) => scope.limit != null);
  const buckets = await Promise.all(
    limited.map((scope) =>
      runAsSystem(() =>
        models.UsageBucket.findOne({
          tenantId,
          periodStart: scope.range.start,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
        })
          .lean()
          .exec(),
      ),
    ),
  );
  return limited.map((scope, index) => ({
    scope,
    remaining: Math.max(
      scope.limit - (buckets[index]?.usedTokens ?? 0) - (buckets[index]?.reservedTokens ?? 0),
      0,
    ),
  }));
}

/**
 * Reserves a request against its institution's and member's credit allowances: the estimated
 * cost at the request's own model, trimmed to what is left so an over-long answer is cut short
 * rather than refused. Settlement replaces the estimate with the actual cost.
 */
async function reserveCredits({
  tenantId,
  userId,
  reservationKey,
  canonical,
  institution,
  policy,
  memberPackage,
  pricingContext,
  estimatedInputTokens,
  requestedOutputTokens,
  metadata,
}) {
  const ranges = getCreditRanges();
  const enforcing = policy.mode === 'enforce';
  const [catalog, existing] = await Promise.all([
    usageCatalog.load(),
    runAsSystem(() => models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec()),
  ]);
  if (existing) {
    return {
      reservation: existing,
      policy,
      range: ranges.month,
      canonical,
      outputTokenCap: enforcing ? existing.outputTokenCap : null,
      outputCapped:
        enforcing &&
        existing.outputTokenCap < (existing.metadata?.requestedOutputTokens ?? Infinity),
      idempotentReplay: true,
    };
  }

  const transactionCapable = await supportsTransactions();
  if (enforcing && !transactionCapable) {
    throw new QuotaError({
      code: 'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
      scope: 'institution',
      tenantId,
    });
  }

  const limits = resolveCreditLimits({
    institutionPackage: institution.usagePackage,
    memberPackage,
    catalog,
  });
  const scopes = buildCreditScopes({ tenantId, userId, limits, ranges });
  /** Credits per token at the request's own model, priced by the client with the billing table. */
  const rates = pricingContext?.rates ?? { input: 0, output: 0 };
  const inputTokens = conservativeInputTokens(
    policy,
    (estimatedInputTokens ?? 0) + Math.max(pricingContext?.overheadTokens ?? 0, 0),
  );
  const requestedOutput = Math.max(
    Number.isFinite(requestedOutputTokens) ? requestedOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    0,
  );
  const inputCredits = estimateCredits({ inputTokens, outputTokens: 0 }, rates);
  const scopeRemaining = await readScopeRemaining(tenantId, scopes);
  const smallestRemaining =
    scopeRemaining.length > 0
      ? Math.min(...scopeRemaining.map((entry) => entry.remaining))
      : Number.POSITIVE_INFINITY;
  const proposedOutputCap = Math.min(
    requestedOutput,
    outputTokensForCredits(smallestRemaining, inputCredits, rates.output),
  );
  const outputTokenCap = enforcing ? proposedOutputCap : requestedOutput;

  if (
    enforcing &&
    (smallestRemaining <= 0 || smallestRemaining < inputCredits || outputTokenCap < 1)
  ) {
    /** Ties resolve to the first scope, ordered institution before member and month before week. */
    const limitingScope = scopeRemaining.find(
      (entry) => entry.remaining === smallestRemaining,
    ).scope;
    recordQuotaDenial(limitingScope.scopeType);
    throw new QuotaError({
      scope: limitingScope.scopeType,
      limitCode: creditLimitCode(limitingScope.scopeType, limitingScope.window),
      window: limitingScope.window,
      meter: 'credits',
      limit: limitingScope.limit,
      used: Math.max(limitingScope.limit - smallestRemaining, 0),
      reserved: 0,
      remaining: smallestRemaining,
      resetAt: limitingScope.range.end.toISOString(),
    });
  }

  const reservedCredits = estimateCredits({ inputTokens, outputTokens: outputTokenCap }, rates);
  const fullCredits = estimateCredits({ inputTokens, outputTokens: requestedOutput }, rates);
  const { result, concurrentReplay } = await persistReservation({
    tenantId,
    reservationKey,
    scopes,
    policy,
    tokens: reservedCredits,
    transactionCapable,
    doc: {
      tenantId,
      reservationKey,
      userId,
      providerKey: canonical.providerKey,
      modelKey: canonical.modelKey,
      policyVersion: Math.max(policy.version, 1),
      periodStart: ranges.month.start,
      periodEnd: ranges.month.end,
      estimatedInputTokens: inputTokens,
      outputTokenCap,
      reservedTokens: reservedCredits,
      weight: 1,
      unit: 'credits',
      scopes: scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        periodStart: scope.range.start,
        periodEnd: scope.range.end,
        limit: scope.limit,
        window: scope.window,
      })),
      status: 'reserved',
      expiresAt: new Date(Date.now() + DEFAULT_RESERVATION_TTL_MS),
      metadata: {
        ...metadata,
        requestedOutputTokens: requestedOutput,
        proposedOutputCap: Number.isFinite(proposedOutputCap) ? proposedOutputCap : requestedOutput,
        rates,
        quotaModel: pricingContext?.model ?? null,
        institutionPackageKey: limits.institutionPackageKey,
        memberPackageKey: limits.memberPackageKey,
        shadowWouldDeny:
          !enforcing && scopeRemaining.some((entry) => entry.remaining < fullCredits),
      },
    },
  });

  return {
    reservation: result,
    policy,
    range: ranges.month,
    canonical,
    outputTokenCap: enforcing ? result.outputTokenCap : null,
    outputCapped: enforcing && result.outputTokenCap < requestedOutput,
    proposedOutputCap,
    idempotentReplay: concurrentReplay,
  };
}

/**
 * Charges a model call that had no reservation of its own (a title, an activity label) to the
 * credit buckets. It already ran, so it is recorded as a settled reservation rather than checked
 * against the limit; the next request sees the smaller allowance. Idempotent on `reservationKey`.
 * Tenants still on the token policy are left alone.
 */
async function recordAuxiliaryCredits({
  tenantId,
  userId,
  memberPackage,
  reservationKey,
  credits,
  metadata,
}) {
  const amount = Math.round(Number(credits) || 0);
  if (!tenantId || !userId || !reservationKey || amount <= 0) {
    return null;
  }
  const { institution, policy } = await loadQuotaContext(tenantId);
  if (!usesCredits(institution.usagePackage, memberPackage)) {
    return null;
  }
  const ranges = getCreditRanges();
  const limits = resolveCreditLimits({
    institutionPackage: institution.usagePackage,
    memberPackage,
    catalog: await usageCatalog.load(),
  });
  const scopes = buildCreditScopes({ tenantId, userId, limits, ranges });
  const policyVersion = Math.max(policy.version, 1);
  const transactionCapable = await supportsTransactions();
  const session = transactionCapable ? await mongoose.startSession() : null;
  let reservation = null;
  const execute = async () => {
    const [created] = await models.UsageReservation.create(
      [
        {
          tenantId,
          reservationKey,
          userId,
          providerKey: 'auxiliary',
          modelKey: metadata?.model ?? 'auxiliary',
          policyVersion,
          periodStart: ranges.month.start,
          periodEnd: ranges.month.end,
          estimatedInputTokens: 0,
          outputTokenCap: 0,
          reservedTokens: 0,
          actualTokens: amount,
          weight: 1,
          unit: 'credits',
          scopes: scopes.map((scope) => ({
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            periodStart: scope.range.start,
            periodEnd: scope.range.end,
            limit: scope.limit,
            window: scope.window,
          })),
          status: 'settled',
          settledAt: new Date(),
          expiresAt: new Date(Date.now() + DEFAULT_RESERVATION_TTL_MS),
          metadata: { ...metadata, auxiliary: true },
        },
      ],
      { session },
    );
    reservation = created.toObject();
    for (const scope of scopes) {
      const query = await loadBucket({
        tenantId,
        range: scope.range,
        scope,
        policyVersion,
        session,
      });
      await models.UsageBucket.updateOne(
        query,
        { $inc: { usedTokens: amount } },
        { session },
      ).exec();
    }
  };
  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } catch (error) {
    if (error?.code === 11000) {
      return null;
    }
    throw error;
  } finally {
    if (session) {
      await session.endSession();
    }
  }
  await emitUsageWarnings(reservation);
  return reservation;
}

/**
 * Reserves capacity for one request. Metered in credits once the institution or the member has a
 * usage package; otherwise on the token policy.
 *
 * @param {object} params
 * @param {object} [params.memberPackage] The member's own package (`req.user.usagePackage`).
 * @param {object} [params.pricingContext] `{ model, endpoint, rates }`: the model the request is
 *   priced at (for an agent, its own model) and its credits per input and output token.
 */
async function reserveUsage(params) {
  const { tenantId, userId, reservationKey, provider, model, memberPackage } = params;
  if (!tenantId || !userId || !reservationKey) {
    throw new QuotaError({
      code: 'INVALID_QUOTA_CONTEXT',
      scope: 'institution',
    });
  }
  const canonical = canonicalizeModel({ provider, model });
  const { institution, policy } = await loadQuotaContext(tenantId);
  if (usesCredits(institution.usagePackage, memberPackage)) {
    return reserveCredits({ ...params, canonical, institution, policy });
  }
  return reserveTokens({ ...params, canonical, policy });
}

async function reserveTokens({
  tenantId,
  userId,
  provider,
  reservationKey,
  endpoint,
  estimatedInputTokens,
  requestedOutputTokens,
  metadata,
  canonical,
  policy,
}) {
  const ranges = getPolicyRanges(policy);
  const range = ranges.month;
  /** The request ENDPOINT, not the provider key, decides weight and unit:
   *  direct Claude and the Office Assistant's Claude both report provider
   *  `anthropic`, so the provider cannot tell them apart. Falls back to
   *  `provider` for callers that predate the explicit `endpoint` argument. */
  const quotaEndpoint = endpoint ?? provider;
  const unit = unitFor(quotaEndpoint);
  const weight = unit === 'images' ? 1 : weightFor(quotaEndpoint);
  const existing = await runAsSystem(() =>
    models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec(),
  );
  if (existing) {
    const enforcing = policy.mode === 'enforce';
    return {
      reservation: existing,
      policy,
      range,
      canonical,
      outputTokenCap: enforcing ? existing.outputTokenCap : null,
      outputCapped:
        enforcing &&
        existing.outputTokenCap < (existing.metadata?.requestedOutputTokens ?? Infinity),
      idempotentReplay: true,
    };
  }

  const transactionCapable = await supportsTransactions();
  if (policy.mode === 'enforce' && !transactionCapable) {
    throw new QuotaError({
      code: 'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
      scope: 'institution',
      tenantId,
    });
  }

  const inputReservation = conservativeInputTokens(policy, estimatedInputTokens);
  const requestedOutput = Math.max(
    Number.isFinite(requestedOutputTokens) ? requestedOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    0,
  );
  const scopes = buildScopes({
    tenantId,
    userId,
    modelKey: canonical.modelKey,
    policy,
    ranges,
    unit,
  });
  /** Remaining is tracked PER SCOPE, not as a bare list: the scope that actually
   *  binds is the one with the least left, and the refusal has to name that
   *  window. Choosing by limit size instead reported the month — and its reset
   *  three weeks out — when it was the week that had run dry. */
  const scopeRemaining = [];
  for (const scope of scopes) {
    if (scope.limit == null) {
      continue;
    }
    const bucket = await runAsSystem(() =>
      models.UsageBucket.findOne({
        tenantId,
        periodStart: scope.range.start,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      })
        .lean()
        .exec(),
    );
    scopeRemaining.push({
      scope,
      remaining: Math.max(
        scope.limit - (bucket?.usedTokens ?? 0) - (bucket?.reservedTokens ?? 0),
        0,
      ),
    });
  }
  const finiteRemaining = scopeRemaining.map((entry) => entry.remaining);
  const smallestRemaining =
    finiteRemaining.length > 0 ? Math.min(...finiteRemaining) : Number.POSITIVE_INFINITY;
  const enforcing = policy.mode === 'enforce';
  /** An image reservation holds exactly one unit, so the output-cap machinery —
   *  which trims a token budget to fit the remaining allowance — does not apply:
   *  an image is indivisible, and capping its "output tokens" would deny every
   *  request whose token estimate exceeds the image allowance. */
  const isImageUnit = unit === 'images';
  const proposedOutputCap = isImageUnit
    ? requestedOutput
    : Math.max(Math.min(requestedOutput, smallestRemaining - inputReservation), 0);
  const outputTokenCap = enforcing && !isImageUnit ? proposedOutputCap : requestedOutput;
  /** Token endpoints hold WEIGHTED tokens — the weight is a quota construct and
   *  never reaches `Transaction`, which stays raw provider cost. */
  const reservedTokens = isImageUnit
    ? 1
    : toBillingTokens(inputReservation + outputTokenCap, weight);

  if (enforcing && (isImageUnit ? smallestRemaining < 1 : outputTokenCap < 1)) {
    /** The binding scope is whichever has the least remaining — that is the value
     *  that drove `smallestRemaining` and therefore the denial. Ties resolve to
     *  the first, which `buildScopes` orders month-before-week. */
    const limitingScope =
      scopeRemaining.find((entry) => entry.remaining === smallestRemaining)?.scope ??
      scopes.find((scope) => scope.limit != null);
    recordQuotaDenial(limitingScope?.scopeType ?? 'institution');
    throw new QuotaError({
      scope: limitingScope?.scopeType ?? 'institution',
      limitCode: resolveLimitCode(limitingScope?.scopeType, limitingScope?.window),
      window: limitingScope?.window ?? 'month',
      meter: isImageUnit ? 'images' : 'tokens',
      modelKey: limitingScope?.scopeType === 'model' ? canonical.modelKey : undefined,
      limit: limitingScope?.limit ?? 0,
      used: Math.max((limitingScope?.limit ?? 0) - smallestRemaining, 0),
      reserved: 0,
      remaining: Math.max(smallestRemaining, 0),
      /** The instant the exhausted window reopens — a hard wall must tell the
       *  user when it lifts, not merely that it exists. */
      resetAt: (limitingScope?.range ?? range).end.toISOString(),
    });
  }

  const { result, concurrentReplay } = await persistReservation({
    tenantId,
    reservationKey,
    scopes,
    policy,
    tokens: reservedTokens,
    transactionCapable,
    doc: {
      tenantId,
      reservationKey,
      userId,
      providerKey: canonical.providerKey,
      modelKey: canonical.modelKey,
      policyVersion: Math.max(policy.version, 1),
      periodStart: range.start,
      periodEnd: range.end,
      estimatedInputTokens: inputReservation,
      outputTokenCap,
      reservedTokens,
      weight,
      unit,
      scopes: scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        periodStart: scope.range.start,
        periodEnd: scope.range.end,
      })),
      status: 'reserved',
      expiresAt: new Date(Date.now() + DEFAULT_RESERVATION_TTL_MS),
      metadata: {
        ...metadata,
        requestedOutputTokens: requestedOutput,
        proposedOutputCap,
        shadowWouldDeny:
          policy.mode === 'shadow' &&
          finiteRemaining.some((remaining) => remaining < inputReservation + requestedOutput),
      },
    },
  });

  return {
    reservation: result,
    policy,
    range,
    canonical,
    outputTokenCap: enforcing ? result.outputTokenCap : null,
    outputCapped: enforcing && result.outputTokenCap < requestedOutput,
    proposedOutputCap,
    idempotentReplay: concurrentReplay,
  };
}

/**
 * Buckets a reservation holds capacity in. Reservations written before
 * multi-window support carry no `scopes`, so they fall back to the original
 * institution/member/model triple on the reservation's own period.
 */
function reservationScopes(reservation) {
  if (Array.isArray(reservation.scopes) && reservation.scopes.length > 0) {
    return reservation.scopes;
  }
  return [
    {
      scopeType: 'institution',
      scopeKey: reservation.tenantId,
      periodStart: reservation.periodStart,
      periodEnd: reservation.periodEnd,
    },
    {
      scopeType: 'member',
      scopeKey: reservation.userId.toString(),
      periodStart: reservation.periodStart,
      periodEnd: reservation.periodEnd,
    },
    {
      scopeType: 'model',
      scopeKey: reservation.modelKey,
      periodStart: reservation.periodStart,
      periodEnd: reservation.periodEnd,
    },
  ];
}

async function transitionReservation({ tenantId, reservationKey, actualTokens, status }) {
  const transactionCapable = await supportsTransactions();
  const session = transactionCapable ? await mongoose.startSession() : null;
  let updated;
  const execute = async () => {
    /** Claim the state transition before touching buckets. This makes settle,
     * release, retry, and abort handlers idempotent even when they race. In a
     * transaction, any later bucket failure rolls the claim back with it. */
    /** Settlement also accepts an already-expired reservation: a generation that
     * outran the reservation TTL still consumed real tokens, and dropping them
     * would understate usage and corrupt the shadow accuracy metrics. Its held
     * capacity was already returned by the expiry pass, so only `usedTokens`
     * moves in that case. */
    const claimable = status === 'settled' ? ['reserved', 'expired'] : ['reserved'];
    const previous = await models.UsageReservation.findOneAndUpdate(
      { tenantId, reservationKey, status: { $in: claimable } },
      {
        $set: {
          status,
          ...(status === 'settled'
            ? { actualTokens: Math.max(actualTokens ?? 0, 0), settledAt: new Date() }
            : { releasedAt: new Date() }),
        },
      },
      { new: false, session },
    )
      .lean()
      .exec();
    if (!previous) {
      updated = await models.UsageReservation.findOne({ tenantId, reservationKey })
        .session(session)
        .lean()
        .exec();
      return;
    }

    const heldTokens = previous.status === 'reserved' ? previous.reservedTokens : 0;
    const settledTokens = Math.max(actualTokens ?? 0, 0);
    for (const scope of reservationScopes(previous)) {
      const increment =
        status === 'settled'
          ? { usedTokens: settledTokens, reservedTokens: -heldTokens }
          : { reservedTokens: -heldTokens };
      const result = await models.UsageBucket.updateOne(
        {
          tenantId,
          periodStart: scope.periodStart ?? previous.periodStart,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          reservedTokens: { $gte: heldTokens },
        },
        { $inc: increment },
        { session },
      ).exec();
      if (result.matchedCount === 0) {
        logger.warn('[usageQuota] bucket missed a reservation transition; totals need a repair', {
          tenantId,
          reservationKey,
          status,
          scopeType: scope.scopeType,
          heldTokens,
        });
      }
    }
    updated = {
      ...previous,
      status,
      ...(status === 'settled'
        ? { actualTokens: settledTokens, settledAt: new Date() }
        : { releasedAt: new Date() }),
    };
  };
  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } finally {
    if (session) {
      await session.endSession();
    }
  }
  return updated;
}

/**
 * Consumes the image meter for images produced inside a TOKEN reservation —
 * i.e. generated by the Office Assistant delegating to the image specialist.
 *
 * These were never reserved: at reservation time the request was on the `agents`
 * endpoint and no subagent had chosen a model yet. So capacity is taken at
 * settlement, after the fact.
 *
 * Consequence, accepted deliberately: a user can exceed the image allowance by
 * at most the images in one request, because the count is unknowable until the
 * run completes. At ~$0.04 an image that is the right trade against holding
 * speculative image capacity on every agent request.
 *
 * Idempotent via `imagesSettled` on the reservation, so a retried or replayed
 * settlement cannot double-count.
 */
async function consumeSettledImages({ tenantId, reservation, images, session }) {
  const count = Math.max(Number(images) || 0, 0);
  if (count === 0 || reservation == null || reservation.unit === 'images') {
    return;
  }
  const claimed = await models.UsageReservation.findOneAndUpdate(
    { tenantId, reservationKey: reservation.reservationKey, imagesSettled: { $in: [null, 0] } },
    { $set: { imagesSettled: count } },
    { new: false, session },
  )
    .lean()
    .exec();
  if (!claimed) {
    return;
  }
  const policy = await getActivePolicy(tenantId);
  const ranges = getPolicyRanges(policy);
  const scopes = buildScopes({
    tenantId,
    userId: reservation.userId,
    modelKey: reservation.modelKey,
    policy,
    ranges,
    unit: 'images',
  });
  for (const scope of scopes) {
    await loadBucket({
      tenantId,
      range: scope.range,
      scope,
      policyVersion: Math.max(policy.version, 1),
      session,
    });
    await models.UsageBucket.updateOne(
      {
        tenantId,
        periodStart: scope.range.start,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      },
      { $inc: { usedTokens: count } },
      { session },
    ).exec();
  }
}

/**
 * @param {object} params
 * @param {number} [params.images] Images generated by this request. For an
 *   image-unit reservation this is the settled count; for a token reservation
 *   (an agent run that delegated to the image specialist) it is consumed
 *   separately against the image meter.
 */
/** Fallback when the client could not price its own run: the tokens at the rates the reservation was made at. */
function creditsFromTokens(usage, rates) {
  const input =
    Math.max(usage?.inputTokens ?? 0, 0) +
    Math.max(usage?.cacheWriteTokens ?? 0, 0) +
    Math.max(usage?.cacheReadTokens ?? 0, 0);
  return Math.ceil(
    input * (rates?.input ?? 0) + Math.max(usage?.outputTokens ?? 0, 0) * (rates?.output ?? 0),
  );
}

/** What a settlement charges, in the reservation's own unit. */
function settledAmount(existing, { usage, images, credits }) {
  if (existing?.unit === 'credits') {
    const actual = Number.isFinite(credits)
      ? Math.round(credits)
      : creditsFromTokens(usage, existing.metadata?.rates);
    return Math.max(actual, 0);
  }
  if (existing?.unit === 'images') {
    return Math.max(images ?? existing.reservedTokens ?? 1, 0);
  }
  const rawTokens =
    Math.max(usage?.inputTokens ?? 0, 0) +
    Math.max(usage?.cacheWriteTokens ?? 0, 0) +
    Math.max(usage?.cacheReadTokens ?? 0, 0) +
    Math.max(usage?.outputTokens ?? 0, 0);
  return toBillingTokens(rawTokens, existing?.weight ?? 1);
}

/**
 * @param {object} params
 * @param {number} [params.credits] Actual credits of the run (credit reservations), priced per
 *   call by the client exactly as `Transaction` prices it.
 * @param {number} [params.images] Images generated by this request (token reservations only).
 */
async function settleUsage({ tenantId, reservationKey, usage, images, credits }) {
  /** Read the weight the reservation was CREATED with rather than recomputing
   *  it: a policy edit mid-request must not settle against a different weight
   *  than it reserved, or the bucket drifts permanently. */
  const existing = await runAsSystem(() =>
    models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec(),
  );
  const actualTokens = settledAmount(existing, { usage, images, credits });
  const reservation = await transitionReservation({
    tenantId,
    reservationKey,
    actualTokens,
    status: 'settled',
  });
  if (reservation?.status === 'settled') {
    if (existing?.unit === 'tokens' || existing?.unit == null) {
      await consumeSettledImages({ tenantId, reservation: existing, images });
    }
    await emitUsageWarnings(reservation);
  }
  return reservation;
}

async function releaseUsage({ tenantId, reservationKey }) {
  return await transitionReservation({ tenantId, reservationKey, status: 'released' });
}

async function reconcileExpiredReservations({ limit = 100 } = {}) {
  const stale = await runAsSystem(() =>
    models.UsageReservation.find({
      status: 'reserved',
      expiresAt: { $lte: new Date() },
    })
      .sort({ expiresAt: 1 })
      .limit(Math.min(Math.max(limit, 1), 1000))
      .lean()
      .exec(),
  );
  let reconciled = 0;
  for (const reservation of stale) {
    const released = await transitionReservation({
      tenantId: reservation.tenantId,
      reservationKey: reservation.reservationKey,
      status: 'expired',
    });
    if (released?.status === 'expired') {
      reconciled += 1;
    }
  }
  recordReservationExpiry(reconciled);
  return { inspected: stale.length, reconciled };
}

/**
 * Recomputes one period's bucket totals from the reservations themselves.
 *
 * Both `usedTokens` and `reservedTokens` are derived from the same snapshot, so
 * a reservation that is still in flight keeps its held capacity instead of
 * being zeroed. Aggregation happens in MongoDB and is grouped down to
 * (member, model) pairs, so memory stays bounded no matter how many
 * reservations the period contains.
 */
async function computePeriodTotals(key, session) {
  const pipeline = [
    {
      $match: {
        tenantId: key.tenantId,
        periodStart: key.periodStart,
        /** Credit reservations repair their own buckets: see `reconcileCreditBuckets`. */
        unit: { $ne: 'credits' },
      },
    },
    {
      $group: {
        _id: { userId: '$userId', modelKey: '$modelKey' },
        usedTokens: {
          $sum: {
            $cond: [{ $eq: ['$status', 'settled'] }, { $ifNull: ['$actualTokens', 0] }, 0],
          },
        },
        reservedTokens: {
          $sum: {
            $cond: [{ $eq: ['$status', 'reserved'] }, { $ifNull: ['$reservedTokens', 0] }, 0],
          },
        },
      },
    },
  ];
  const aggregation = models.UsageReservation.aggregate(pipeline);
  if (session) {
    aggregation.session(session);
  }
  const rows = await aggregation.exec();

  const totals = new Map();
  const accumulate = (scopeType, scopeKey, row) => {
    const mapKey = `${scopeType}:${scopeKey}`;
    const current = totals.get(mapKey) ?? {
      scopeType,
      scopeKey,
      usedTokens: 0,
      reservedTokens: 0,
    };
    current.usedTokens += row.usedTokens ?? 0;
    current.reservedTokens += row.reservedTokens ?? 0;
    totals.set(mapKey, current);
  };

  for (const row of rows) {
    accumulate('institution', key.tenantId, row);
    accumulate('member', String(row._id.userId), row);
    accumulate('model', row._id.modelKey, row);
  }
  return totals;
}

async function writePeriodTotals({ key, policyVersion, totals, session }) {
  if (totals.size === 0) {
    return;
  }
  await models.UsageBucket.bulkWrite(
    [...totals.values()].map((total) => ({
      updateOne: {
        filter: {
          tenantId: key.tenantId,
          periodStart: key.periodStart,
          scopeType: total.scopeType,
          scopeKey: total.scopeKey,
        },
        update: {
          $set: {
            periodEnd: key.periodEnd,
            policyVersion,
            usedTokens: total.usedTokens,
            reservedTokens: total.reservedTokens,
          },
        },
        upsert: true,
      },
    })),
    { session },
  );
}

/**
 * Repairs bucket totals from the reservation ledger.
 *
 * Where transactions are available the recompute and the write share one
 * snapshot, so a concurrent reservation cannot slip between them. Without
 * transactions only closed periods are repaired — a period whose end has
 * passed can never receive another reservation, so there is nothing to race.
 */
/** Credit bucket totals for one window, from the scopes each credit reservation recorded. */
async function computeCreditTotals(key, session) {
  const aggregation = models.UsageReservation.aggregate([
    { $match: { tenantId: key.tenantId, unit: 'credits', 'scopes.periodStart': key.periodStart } },
    { $unwind: '$scopes' },
    { $match: { 'scopes.periodStart': key.periodStart } },
    {
      $group: {
        _id: { scopeType: '$scopes.scopeType', scopeKey: '$scopes.scopeKey' },
        usedTokens: {
          $sum: {
            $cond: [{ $eq: ['$status', 'settled'] }, { $ifNull: ['$actualTokens', 0] }, 0],
          },
        },
        reservedTokens: {
          $sum: {
            $cond: [{ $eq: ['$status', 'reserved'] }, { $ifNull: ['$reservedTokens', 0] }, 0],
          },
        },
      },
    },
  ]);
  if (session) {
    aggregation.session(session);
  }
  const rows = await aggregation.exec();
  return new Map(
    rows.map((row) => [
      `${row._id.scopeType}:${row._id.scopeKey}`,
      {
        scopeType: row._id.scopeType,
        scopeKey: row._id.scopeKey,
        usedTokens: row.usedTokens,
        reservedTokens: row.reservedTokens,
      },
    ]),
  );
}

/**
 * Repairs credit buckets for every weekly and monthly window with no reservation in flight.
 * Without transactions, only windows that have ended are repaired, as for token buckets.
 */
async function reconcileCreditBuckets({ limit, now, transactionCapable }) {
  const windows = await runAsSystem(() =>
    models.UsageReservation.aggregate([
      { $match: { unit: 'credits' } },
      { $unwind: '$scopes' },
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            periodStart: '$scopes.periodStart',
            periodEnd: '$scopes.periodEnd',
          },
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
          policyVersion: { $max: '$policyVersion' },
        },
      },
      { $match: { activeCount: 0 } },
      { $sort: { '_id.periodStart': -1 } },
      { $limit: Math.min(Math.max(limit, 1), 1000) },
    ]),
  );
  let repaired = 0;
  let deferred = 0;
  for (const window of windows) {
    const key = window._id;
    const closed = new Date(key.periodEnd) <= now;
    if (!transactionCapable && !closed) {
      deferred += 1;
      continue;
    }
    const repair = async (session) => {
      const totals = await computeCreditTotals(key, session);
      await writePeriodTotals({ key, policyVersion: window.policyVersion, totals, session });
    };
    if (!transactionCapable) {
      await runAsSystem(() => repair(null));
      repaired += 1;
      continue;
    }
    const session = await mongoose.startSession();
    try {
      await runAsSystem(() => session.withTransaction(() => repair(session)));
      repaired += 1;
    } finally {
      await session.endSession();
    }
  }
  return { repaired, deferred };
}

async function reconcileQuotaState({ limit = 100, now = new Date() } = {}) {
  const expiry = await reconcileExpiredReservations({ limit });
  const transactionCapable = await supportsTransactions();
  const periods = await runAsSystem(() =>
    models.UsageReservation.aggregate([
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            periodStart: '$periodStart',
            periodEnd: '$periodEnd',
          },
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
          policyVersion: { $max: '$policyVersion' },
        },
      },
      { $match: { activeCount: 0 } },
      { $sort: { '_id.periodStart': -1 } },
      { $limit: Math.min(Math.max(limit, 1), 1000) },
    ]),
  );

  let repairedPeriods = 0;
  let deferredPeriods = 0;

  for (const period of periods) {
    const key = period._id;
    const periodEnd = key.periodEnd instanceof Date ? key.periodEnd : new Date(key.periodEnd);
    const periodClosed = periodEnd <= now;

    if (!transactionCapable && !periodClosed) {
      deferredPeriods += 1;
      continue;
    }

    if (!transactionCapable) {
      await runAsSystem(async () => {
        const totals = await computePeriodTotals(key, null);
        await writePeriodTotals({
          key,
          policyVersion: period.policyVersion,
          totals,
          session: null,
        });
      });
      repairedPeriods += 1;
      continue;
    }

    const session = await mongoose.startSession();
    try {
      await runAsSystem(() =>
        session.withTransaction(async () => {
          const totals = await computePeriodTotals(key, session);
          await writePeriodTotals({
            key,
            policyVersion: period.policyVersion,
            totals,
            session,
          });
        }),
      );
      repairedPeriods += 1;
    } finally {
      await session.endSession();
    }
  }

  const credit = await reconcileCreditBuckets({ limit, now, transactionCapable });

  return {
    ...expiry,
    inspectedPeriods: periods.length,
    repairedPeriods,
    deferredPeriods,
    repairedCreditWindows: credit.repaired,
    deferredCreditWindows: credit.deferred,
  };
}

/**
 * A member's remaining allowance on both meters and both windows.
 *
 * Reads only the CURRENT windows — there is no date range, so this cannot be
 * walked backwards into a usage-history API by a caller who only holds
 * quota-read permission.
 *
 * A `null` limit means unlimited (shadow mode, or a superadmin override): usage
 * is still reported, `remaining` is simply absent.
 */
/**
 * A credit member's allowance this week and month. The institution's pooled allowance is
 * reported only as blocked or not, with its reset: its size is the institution's, not the member's.
 */
async function getMemberCreditQuota({ tenantId, userId, institution, policy, memberPackage, now }) {
  const ranges = getCreditRanges(now);
  const catalog = await usageCatalog.load();
  const limits = resolveCreditLimits({
    institutionPackage: institution.usagePackage,
    memberPackage,
    catalog,
    now,
  });
  const scopes = buildCreditScopes({ tenantId, userId, limits, ranges });
  const buckets = await runAsSystem(() =>
    models.UsageBucket.find({
      tenantId,
      $or: scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        periodStart: scope.range.start,
      })),
    })
      .lean()
      .exec(),
  );
  const bdtPerCredit = effectiveBdtPerUsd(catalog.pricing) / CREDITS_PER_USD;
  const toBdt = (credits) =>
    credits == null ? null : Math.round(credits * bdtPerCredit * 100) / 100;
  const meters = scopes.map((scope) => {
    const bucket = buckets.find(
      (candidate) =>
        candidate.scopeType === scope.scopeType &&
        candidate.scopeKey === scope.scopeKey &&
        new Date(candidate.periodStart).getTime() === scope.range.start.getTime(),
    );
    const used = (bucket?.usedTokens ?? 0) + (bucket?.reservedTokens ?? 0);
    const blocked = scope.limit != null && used >= scope.limit;
    if (scope.scopeType === 'institution_credits') {
      return {
        meter: 'institution',
        window: scope.window,
        used: null,
        limit: null,
        remaining: null,
        unlimited: scope.limit == null,
        blocked,
        resetsAt: scope.range.end.toISOString(),
      };
    }
    const remaining = scope.limit == null ? null : Math.max(scope.limit - used, 0);
    return {
      meter: 'credits',
      window: scope.window,
      used,
      limit: scope.limit,
      remaining,
      usedBdt: toBdt(used),
      limitBdt: toBdt(scope.limit),
      remainingBdt: toBdt(remaining),
      unlimited: scope.limit == null,
      blocked,
      resetsAt: scope.range.end.toISOString(),
    };
  });
  const pkg = limits.memberPackageKey ? catalog.packages.get(limits.memberPackageKey) : null;
  return {
    tenantId,
    unit: 'credits',
    enforced: policy.mode === 'enforce',
    package: pkg ? { key: pkg.key, name: pkg.name, unlimited: pkg.unlimited === true } : null,
    meters,
  };
}

async function getMemberQuota({ tenantId, userId, memberPackage, now = new Date() }) {
  const { institution, policy } = await loadQuotaContext(tenantId);
  if (usesCredits(institution.usagePackage, memberPackage)) {
    return getMemberCreditQuota({ tenantId, userId, institution, policy, memberPackage, now });
  }
  const ranges = getPolicyRanges(policy, now);
  const memberKey = String(userId);
  const windows = [
    { window: 'month', range: ranges.month },
    ...(ranges.week ? [{ window: 'week', range: ranges.week }] : []),
  ];
  const periodStarts = windows.map((entry) => entry.range.start);
  const buckets = await runAsSystem(() =>
    models.UsageBucket.find({
      tenantId,
      scopeKey: memberKey,
      scopeType: { $in: ['member', 'member_images'] },
      periodStart: { $in: periodStarts },
    })
      .lean()
      .exec(),
  );

  const limitFor = (meter, window) => {
    const limits = policy.limits ?? {};
    if (meter === 'images') {
      return (window === 'week' ? limits.memberImagesWeekly : limits.memberImages) ?? null;
    }
    return (window === 'week' ? limits.memberTokensWeekly : limits.memberTokens) ?? null;
  };

  const meters = [];
  for (const meter of ['tokens', 'images']) {
    const scopeType = meter === 'images' ? 'member_images' : 'member';
    for (const { window, range } of windows) {
      const bucket = buckets.find(
        (candidate) =>
          candidate.scopeType === scopeType &&
          new Date(candidate.periodStart).getTime() === range.start.getTime(),
      );
      const used = (bucket?.usedTokens ?? 0) + (bucket?.reservedTokens ?? 0);
      const limit = limitFor(meter, window);
      meters.push({
        meter,
        window,
        used,
        limit,
        remaining: limit == null ? null : Math.max(limit - used, 0),
        unlimited: limit == null,
        blocked: limit != null && used >= limit,
        resetsAt: range.end.toISOString(),
      });
    }
  }

  return {
    tenantId,
    /** Weighted, not raw: this is the number the wall is enforced against. */
    unit: 'billing_tokens',
    enforced: policy.mode === 'enforce',
    meters,
  };
}

/**
 * Limit of a credit bucket for the institution view. Members on their own package are shown
 * against the institution's default member package; their own limit lives on their user record.
 */
function creditBucketLimit(bucket, creditRanges, limits) {
  const window =
    new Date(bucket.periodStart).getTime() === creditRanges.week.start.getTime() ? 'week' : 'month';
  const windows = bucket.scopeType === 'institution_credits' ? limits.institution : limits.member;
  return windows[window] ?? null;
}

async function getQuotaHealth({ tenantId, now = new Date() }) {
  const { institution, policy } = await loadQuotaContext(tenantId);
  const ranges = getPolicyRanges(policy, now);
  const range = ranges.month;
  const creditRanges = getCreditRanges(now);
  const creditLimits = usesCredits(institution.usagePackage)
    ? resolveCreditLimits({
        institutionPackage: institution.usagePackage,
        catalog: await usageCatalog.load(),
        now,
      })
    : null;
  const periodStarts = [
    ...new Set(
      [ranges.month.start, ranges.week?.start, creditRanges.week.start]
        .filter(Boolean)
        .map((date) => date.getTime()),
    ),
  ].map((time) => new Date(time));
  const buckets = await runAsSystem(() =>
    models.UsageBucket.find({ tenantId, periodStart: { $in: periodStarts } })
      .lean()
      .exec(),
  );
  const warnings = await runAsSystem(() =>
    models.UsageWarning.find({ tenantId, periodStart: { $in: periodStarts } })
      .sort({ createdAt: -1 })
      .lean()
      .exec(),
  );
  return {
    policy,
    range,
    warnings,
    buckets: buckets.map((bucket) => {
      if (isCreditScope(bucket.scopeType)) {
        const limit = creditLimits ? creditBucketLimit(bucket, creditRanges, creditLimits) : null;
        const consumed = bucket.usedTokens + bucket.reservedTokens;
        return {
          ...bucket,
          limit,
          remaining: limit == null ? null : Math.max(limit - consumed, 0),
          utilization: limit == null || limit === 0 ? null : consumed / limit,
          blocked: limit != null && consumed >= limit,
        };
      }
      /** A member now has one bucket per window, so scopeType+scopeKey alone is
       *  ambiguous — the period start is what separates weekly from monthly. */
      const isImages = bucket.scopeType === 'member_images';
      const scope = buildScopes({
        tenantId,
        userId: bucket.scopeType === 'member' || isImages ? bucket.scopeKey : '',
        modelKey: bucket.scopeType === 'model' ? bucket.scopeKey : '',
        policy,
        ranges,
        unit: isImages ? 'images' : 'tokens',
      }).find(
        (candidate) =>
          candidate.scopeType === bucket.scopeType &&
          candidate.scopeKey === bucket.scopeKey &&
          candidate.range.start.getTime() === new Date(bucket.periodStart).getTime(),
      );
      const limit = scope?.limit ?? null;
      const consumed = bucket.usedTokens + bucket.reservedTokens;
      return {
        ...bucket,
        limit,
        remaining: limit == null ? null : Math.max(limit - consumed, 0),
        utilization: limit == null || limit === 0 ? null : consumed / limit,
        blocked: limit != null && consumed >= limit,
      };
    }),
  };
}

function isCreditScope(scopeType) {
  return scopeType === 'institution_credits' || scopeType === 'member_credits';
}

/** Credits are shown in taka at the current pricing; token and image counts as plain numbers. */
async function usageAmountFormatter(scopeType) {
  if (!isCreditScope(scopeType)) {
    return (value) => String(value);
  }
  const { pricing } = await usageCatalog.load();
  const rate = effectiveBdtPerUsd(pricing);
  return (value) => `৳${((value / CREDITS_PER_USD) * rate).toFixed(2)}`;
}

async function emailUsageWarning(warning) {
  if (!checkEmailConfig()) {
    return;
  }
  const [institution, admins] = await runAsSystem(() =>
    Promise.all([
      models.Institution.findOne({ tenantId: warning.tenantId }).select('name').lean().exec(),
      models.User.find({
        tenantId: warning.tenantId,
        role: 'INSTITUTION_ADMIN',
        membershipStatus: 'active',
      })
        .select('name email')
        .lean()
        .exec(),
    ]),
  );
  if (admins.length === 0) {
    return;
  }
  const format = await usageAmountFormatter(warning.scopeType);
  await Promise.all(
    admins.map((admin) =>
      sendEmail({
        email: admin.email,
        subject: `${institution?.name ?? warning.tenantId} token usage warning`,
        payload: {
          name: admin.name || admin.email,
          institutionName: institution?.name ?? warning.tenantId,
          threshold: String(Math.round(warning.threshold * 100)),
          scope: warning.scopeType,
          scopeKey: warning.scopeKey,
          used: format(warning.usedTokens),
          reserved: format(warning.reservedTokens),
          limit: format(warning.limit),
          resetAt: warning.periodEnd.toISOString(),
        },
        template: 'usageWarning.handlebars',
        throwError: false,
      }),
    ),
  );
  await runAsSystem(() =>
    models.UsageWarning.updateOne({ _id: warning._id }, { $set: { emailedAt: new Date() } }),
  );
}

/** Limits for a reservation's scopes. Credit scopes carry the limit they were reserved under. */
function warningScopes(reservation, policy) {
  const scopes = reservationScopes(reservation);
  if (reservation.unit === 'credits') {
    return scopes.map((scope) => ({
      scope,
      limit: scope.limit ?? null,
      periodStart: scope.periodStart,
      periodEnd: scope.periodEnd,
    }));
  }
  const ranges = getPolicyRanges(policy);
  return scopes.map((scope) => ({
    scope,
    limit: buildScopes({
      tenantId: reservation.tenantId,
      userId: reservation.userId,
      modelKey: reservation.modelKey,
      policy,
      ranges,
      unit: reservation.unit === 'images' ? 'images' : 'tokens',
    }).find(
      (candidate) =>
        candidate.scopeType === scope.scopeType &&
        candidate.range.start.getTime() === new Date(scope.periodStart).getTime(),
    )?.limit,
    periodStart: reservation.periodStart,
    periodEnd: reservation.periodEnd,
  }));
}

async function emitUsageWarnings(reservation) {
  const policy = await getActivePolicy(reservation.tenantId);
  const thresholds = policy.warningThresholds ?? [0.8, 0.9];
  for (const { scope, limit, periodStart, periodEnd } of warningScopes(reservation, policy)) {
    if (limit == null || limit <= 0) {
      continue;
    }
    const bucket = await runAsSystem(() =>
      models.UsageBucket.findOne({
        tenantId: reservation.tenantId,
        periodStart,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      })
        .lean()
        .exec(),
    );
    if (!bucket) {
      continue;
    }
    const utilization = (bucket.usedTokens + bucket.reservedTokens) / limit;
    for (const threshold of thresholds) {
      if (utilization < threshold) {
        continue;
      }
      const result = await runAsSystem(() =>
        models.UsageWarning.updateOne(
          {
            tenantId: reservation.tenantId,
            periodStart,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            threshold,
          },
          {
            $setOnInsert: {
              periodEnd,
              utilization,
              usedTokens: bucket.usedTokens,
              reservedTokens: bucket.reservedTokens,
              limit,
            },
          },
          { upsert: true },
        ),
      );
      if (result.upsertedCount === 1) {
        const warning = await runAsSystem(() =>
          models.UsageWarning.findOne({
            tenantId: reservation.tenantId,
            periodStart,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            threshold,
          })
            .lean()
            .exec(),
        );
        if (warning) {
          await emailUsageWarning(warning);
        }
      }
    }
  }
}

/**
 * Reports whether any institution is *currently* enforcing. Policies are
 * immutable and append-only, so a tenant that once enforced and has since
 * rolled back still owns an enforce-mode document; only the version each
 * institution actually points at counts.
 */
async function hasActiveEnforcingPolicy() {
  return await runAsSystem(async () => {
    const institutions = await models.Institution.find({ usagePolicyVersion: { $gte: 1 } })
      .select('tenantId usagePolicyVersion')
      .lean()
      .exec();
    const batchSize = 200;
    for (let index = 0; index < institutions.length; index += batchSize) {
      const batch = institutions.slice(index, index + batchSize);
      const found = await models.UsagePolicy.exists({
        mode: 'enforce',
        $or: batch.map((institution) => ({
          tenantId: institution.tenantId,
          version: institution.usagePolicyVersion,
        })),
      });
      if (found) {
        return true;
      }
    }
    return false;
  });
}

async function assertEnforcementTopology() {
  const enforcingPolicy = await hasActiveEnforcingPolicy();
  if (!enforcingPolicy) {
    return { enforcing: false, transactionCapable: await supportsTransactions() };
  }
  const transactionCapable = await supportsTransactions();
  if (!transactionCapable) {
    throw new Error(
      'Quota enforce mode requires MongoDB replica-set or mongos transaction support',
    );
  }
  return { enforcing: true, transactionCapable };
}

/**
 * Measures whether an institution's shadow observation is trustworthy enough to
 * switch on enforcement.
 *
 * All reservation metrics are aggregated in MongoDB: a tenant that has reached
 * the call threshold has far too many reservations to pull into memory.
 *
 * `observedDays` measures the full span since the tenant's first reservation,
 * not the span inside the sampling window — the earliest reservation within a
 * 7-day window is by definition younger than 7 days, so a windowed measure
 * could never reach the threshold it is compared against.
 *
 * Coverage compares reservations against distinct primary inferences in the
 * ledger (`context: 'message'`, keyed by conversation and message). Auxiliary
 * spend — titles, vision tools, assistants runs — is reported separately as
 * `unreservedAuxiliaryCalls` because those paths are ledgered but not yet
 * reserved; they are informational, not part of the coverage ratio.
 */
async function getShadowReadiness({ tenantId, minimumDays = 7, minimumCalls = 1000 }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - minimumDays * 24 * 60 * 60 * 1000);
  const [
    reservationSummary,
    firstReservation,
    unattributedEvents,
    duplicateGroups,
    primaryLedgerCalls,
    auxiliaryLedgerCalls,
  ] = await runAsSystem(() =>
    Promise.all([
      models.UsageReservation.aggregate([
        { $match: { tenantId, createdAt: { $gte: cutoff } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } },
            stale: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$status', 'expired'] },
                      {
                        $and: [{ $eq: ['$status', 'reserved'] }, { $lte: ['$expiresAt', now] }],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            underestimated: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'settled'] },
                      { $gt: [{ $ifNull: ['$actualTokens', 0] }, '$reservedTokens'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            totalActual: {
              $sum: {
                $cond: [{ $eq: ['$status', 'settled'] }, { $ifNull: ['$actualTokens', 0] }, 0],
              },
            },
            totalUnderestimate: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'settled'] },
                  {
                    $max: [
                      { $subtract: [{ $ifNull: ['$actualTokens', 0] }, '$reservedTokens'] },
                      0,
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]),
      models.UsageReservation.find({ tenantId })
        .sort({ createdAt: 1 })
        .limit(1)
        .select('createdAt')
        .lean()
        .exec(),
      mongoose.models.Transaction.countDocuments({
        tenantId,
        createdAt: { $gte: cutoff },
        $or: [
          { requestKey: { $exists: false } },
          { providerKey: { $exists: false } },
          { modelKey: { $exists: false } },
          { user: { $exists: false } },
        ],
      }),
      mongoose.models.Transaction.aggregate([
        { $match: { tenantId, createdAt: { $gte: cutoff }, requestKey: { $type: 'string' } } },
        {
          $group: {
            _id: { requestKey: '$requestKey', tokenType: '$tokenType', valueKey: '$valueKey' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: 'groups' },
      ]),
      mongoose.models.Transaction.aggregate([
        {
          $match: {
            tenantId,
            createdAt: { $gte: cutoff },
            context: 'message',
            messageId: { $type: 'string' },
          },
        },
        { $group: { _id: { conversationId: '$conversationId', messageId: '$messageId' } } },
        { $count: 'calls' },
      ]),
      mongoose.models.Transaction.aggregate([
        {
          $match: {
            tenantId,
            createdAt: { $gte: cutoff },
            context: { $ne: 'message' },
            requestKey: { $type: 'string' },
          },
        },
        { $group: { _id: '$requestKey' } },
        { $count: 'calls' },
      ]),
    ]),
  );

  const summary = reservationSummary[0] ?? {
    total: 0,
    settled: 0,
    stale: 0,
    underestimated: 0,
    totalActual: 0,
    totalUnderestimate: 0,
  };
  const earliestCreatedAt = firstReservation[0]?.createdAt;
  const observedDays = earliestCreatedAt
    ? (now.getTime() - new Date(earliestCreatedAt).getTime()) / (24 * 60 * 60 * 1000)
    : 0;
  const staleRate = summary.total === 0 ? 0 : summary.stale / summary.total;
  const underestimateRate = summary.settled === 0 ? 0 : summary.underestimated / summary.settled;
  const estimationOverageRate =
    summary.totalActual === 0 ? 0 : summary.totalUnderestimate / summary.totalActual;
  const ledgerCalls = primaryLedgerCalls[0]?.calls ?? 0;
  const reservationCoverageRate = ledgerCalls === 0 ? 0 : Math.min(summary.total / ledgerCalls, 1);
  const metrics = {
    observedDays,
    attributableCalls: summary.total,
    settledCalls: summary.settled,
    unattributedEvents,
    duplicateGroups: duplicateGroups[0]?.groups ?? 0,
    staleReservations: summary.stale,
    staleRate,
    underestimatedCalls: summary.underestimated,
    underestimateRate,
    estimationOverageRate,
    ledgerCalls,
    uncoveredLedgerCalls: Math.max(ledgerCalls - summary.total, 0),
    unreservedAuxiliaryCalls: auxiliaryLedgerCalls[0]?.calls ?? 0,
    reservationCoverageRate,
  };
  return {
    tenantId,
    generatedAt: now,
    requirements: {
      minimumDays,
      minimumCalls,
      maximumStaleRate: 0.001,
      maximumUnderestimateRate: 0.001,
      maximumEstimationOverageRate: 0.005,
      minimumReservationCoverageRate: 1,
    },
    metrics,
    ready:
      observedDays >= minimumDays &&
      summary.total >= minimumCalls &&
      unattributedEvents === 0 &&
      (duplicateGroups[0]?.groups ?? 0) === 0 &&
      staleRate < 0.001 &&
      underestimateRate <= 0.001 &&
      estimationOverageRate < 0.005 &&
      reservationCoverageRate === 1,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  QUOTA_RESET_TIMEZONE,
  QuotaError,
  assertEnforcementTopology,
  canonicalizeModel,
  getActivePolicy,
  getCalendarMonthRange,
  getCalendarWeekRange,
  getMemberQuota,
  getPolicyRanges,
  getQuotaHealth,
  getShadowReadiness,
  isEnforcementDenial,
  reconcileExpiredReservations,
  reconcileQuotaState,
  recordAuxiliaryCredits,
  releaseUsage,
  reserveUsage,
  settleUsage,
  zonedDateTimeToUtc,
};
