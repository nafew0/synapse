import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { ITransaction, IUsageBucket } from '@librechat/data-schemas';
import type { PricingFns } from '~/agents/transactions';
import { calculateTokenValue, calculateStructuredTokenValue } from '~/agents/transactions';
import { dhakaDay, rebuildDay } from './rollup';
import { CREDITS_PER_USD } from './packages';

export const HAIKU_TIER_CORRECTION_ID: string = 'haiku-5.5-long-prompt-tier';

/** `anthropic/claude-haiku-5.5`, `claude-haiku-5-5`, `anthropic/claude-haiku-5.5-20261001`, any case. */
export const HAIKU_5_5_PATTERN: RegExp = /claude-haiku-5[.-]5/i;

const CREDIT_SCOPES = ['institution_credits', 'member_credits'] as const;
const CHUNK_SIZE = 500;
/** Relative tolerance below which a recomputed value counts as unchanged (float noise). */
const EPSILON = 1e-9;

type Row = Pick<
  ITransaction,
  | '_id'
  | 'user'
  | 'conversationId'
  | 'tenantId'
  | 'tokenType'
  | 'model'
  | 'modelKey'
  | 'providerModelId'
  | 'context'
  | 'requestKey'
  | 'messageId'
  | 'rawAmount'
  | 'inputTokens'
  | 'writeTokens'
  | 'readTokens'
  | 'tokenValue'
  | 'rate'
  | 'createdAt'
  | 'costCorrection'
>;

export interface RowChange {
  id: string;
  tenantId: string;
  user: string;
  createdAt: Date;
  tokenType: string;
  promptTokens: number;
  before: { tokenValue: number; rate: number };
  after: { tokenValue: number; rate: number };
}

export interface BucketChange {
  tenantId: string;
  scopeType: (typeof CREDIT_SCOPES)[number];
  scopeKey: string;
  periodStart: Date;
  periodEnd: Date;
  credits: number;
}

export interface Slice {
  month: string;
  tenantId: string;
  rows: number;
  beforeUsd: number;
  afterUsd: number;
}

export interface CorrectionOptions {
  pricing: PricingFns;
  /** Writes nothing unless `false`. */
  dryRun?: boolean;
  /** Only rows created at or after this instant. */
  since?: Date;
  /** Only this tenant. */
  tenantId?: string;
  /** Directory the audit note is written to; none is written when absent. */
  auditDir?: string;
  now?: Date;
}

export interface CorrectionResult {
  runId: string;
  dryRun: boolean;
  rowsScanned: number;
  rowsChanged: number;
  /** Rows not repriced because their call's prompt size is unknown (no prompt row to pair with). */
  rowsUnpaired: number;
  rowsAlreadyCorrect: number;
  slices: Slice[];
  buckets: BucketChange[];
  /** Credit buckets whose window holds a corrected row but that did not exist yet when the row was written. */
  bucketsMissing: number;
  days: string[];
  auditFile?: string;
  changes: RowChange[];
}

const monthOf = (at: Date): string => dhakaDay(at).slice(0, 7);
const usd = (credits: number): number => Math.abs(credits) / CREDITS_PER_USD;
const differs = (a: number, b: number): boolean =>
  Math.abs(a - b) > EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const modelOf = (row: Row): string | undefined => row.model ?? row.providerModelId ?? row.modelKey;
const isStructured = (row: Row): boolean =>
  row.writeTokens != null || row.readTokens != null || row.inputTokens != null;
const tenantOf = (row: Row): string => row.tenantId ?? '';

/** A prompt and its completion share a call; the call's prompt size decides the tier of both. */
function callKey(row: Row): string | undefined {
  if (row.requestKey) {
    return `${tenantOf(row)}\u0000${row.requestKey}`;
  }
  return row.messageId
    ? `${tenantOf(row)}\u0000m:${row.messageId}:${row.context ?? ''}`
    : undefined;
}

function promptTokensOf(row: Row): number {
  if (isStructured(row)) {
    return (
      Math.abs(row.inputTokens ?? 0) +
      Math.abs(row.writeTokens ?? 0) +
      Math.abs(row.readTokens ?? 0)
    );
  }
  return Math.abs(row.rawAmount ?? 0);
}

function reprice(row: Row, inputTokenCount: number, pricing: PricingFns) {
  const model = modelOf(row);
  const context = row.context ?? 'message';
  if (row.tokenType === 'prompt' && isStructured(row)) {
    const { tokenValue, rate } = calculateStructuredTokenValue(
      {
        user: String(row.user),
        conversationId: row.conversationId ?? '',
        tokenType: 'prompt',
        model,
        context,
        inputTokens: row.inputTokens,
        writeTokens: row.writeTokens,
        readTokens: row.readTokens,
        inputTokenCount,
      },
      pricing,
    );
    return { tokenValue, rate };
  }
  return calculateTokenValue(
    {
      user: String(row.user),
      conversationId: row.conversationId ?? '',
      tokenType: row.tokenType as 'prompt' | 'completion',
      model,
      context,
      rawAmount: row.rawAmount ?? 0,
      inputTokenCount,
    },
    pricing,
  );
}

/** Pairs each call's rows and returns the rows whose recomputed cost differs from the stored one. */
export function planRowChanges(
  rows: Row[],
  pricing: PricingFns,
): Pick<CorrectionResult, 'rowsUnpaired' | 'rowsAlreadyCorrect'> & {
  changes: RowChange[];
  slices: Slice[];
} {
  const promptByCall = rows.reduce((map, row) => {
    const key = callKey(row);
    if (row.tokenType !== 'prompt' || key == null) {
      return map;
    }
    return map.set(key, (map.get(key) ?? 0) + promptTokensOf(row));
  }, new Map<string, number>());

  const slices = new Map<string, Slice>();
  const changes: RowChange[] = [];
  let rowsUnpaired = 0;
  let rowsAlreadyCorrect = 0;

  for (const row of rows) {
    const key = callKey(row);
    const promptTokens = key == null ? undefined : promptByCall.get(key);
    if (promptTokens == null || row.createdAt == null) {
      rowsUnpaired += 1;
      continue;
    }
    const before = { tokenValue: row.tokenValue ?? 0, rate: row.rate ?? 0 };
    const after = reprice(row, promptTokens, pricing);
    const sliceKey = `${monthOf(row.createdAt)}|${tenantOf(row)}`;
    const slice = slices.get(sliceKey) ?? {
      month: monthOf(row.createdAt),
      tenantId: tenantOf(row),
      rows: 0,
      beforeUsd: 0,
      afterUsd: 0,
    };
    slice.rows += 1;
    slice.beforeUsd += usd(before.tokenValue);
    slice.afterUsd += usd(after.tokenValue);
    slices.set(sliceKey, slice);

    if (!differs(before.tokenValue, after.tokenValue) && !differs(before.rate, after.rate)) {
      rowsAlreadyCorrect += 1;
      continue;
    }
    changes.push({
      id: String(row._id),
      tenantId: tenantOf(row),
      user: String(row.user),
      createdAt: row.createdAt,
      tokenType: row.tokenType,
      promptTokens,
      before,
      after,
    });
  }

  const ordered = [...slices.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.tenantId.localeCompare(b.tenantId),
  );
  return { changes, slices: ordered, rowsUnpaired, rowsAlreadyCorrect };
}

/** Credits added to each credit bucket whose window held the row when it was written. */
export function planBucketChanges(
  changes: RowChange[],
  buckets: IUsageBucket[],
): { buckets: BucketChange[]; missing: number } {
  const byOwner = buckets.reduce((map, bucket) => {
    const key = `${bucket.tenantId}|${bucket.scopeType}|${bucket.scopeKey}`;
    return map.set(key, [...(map.get(key) ?? []), bucket]);
  }, new Map<string, IUsageBucket[]>());

  const totals = new Map<string, BucketChange>();
  let missing = 0;
  for (const change of changes) {
    const credits = Math.abs(change.after.tokenValue) - Math.abs(change.before.tokenValue);
    const owners = [
      ['institution_credits', change.tenantId],
      ['member_credits', change.user],
    ] as const;
    for (const [scopeType, scopeKey] of owners) {
      const candidates = byOwner.get(`${change.tenantId}|${scopeType}|${scopeKey}`) ?? [];
      const inWindow = candidates.filter(
        (bucket) =>
          bucket.periodStart <= change.createdAt &&
          change.createdAt < bucket.periodEnd &&
          (bucket.createdAt == null || bucket.createdAt <= change.createdAt),
      );
      if (inWindow.length === 0) {
        missing += 1;
        continue;
      }
      for (const bucket of inWindow) {
        const id = String(bucket._id);
        const entry = totals.get(id) ?? {
          tenantId: bucket.tenantId,
          scopeType,
          scopeKey,
          periodStart: bucket.periodStart,
          periodEnd: bucket.periodEnd,
          credits: 0,
        };
        entry.credits += credits;
        totals.set(id, entry);
      }
    }
  }
  return { buckets: [...totals.values()], missing };
}

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** Whether the connected deployment can run multi-document transactions (replica set or sharded). */
function supportsTransactions(): boolean {
  const type = (
    mongoose.connection.getClient() as unknown as {
      topology?: { description?: { type?: string } };
    }
  ).topology?.description?.type;
  return type != null && /^(ReplicaSet|Sharded|LoadBalanced)/.test(type);
}

async function writeChunk(
  changes: RowChange[],
  runId: string,
  at: Date,
  session?: mongoose.ClientSession,
): Promise<void> {
  const written = await mongoose.models.Transaction.bulkWrite(
    changes.map((change) => ({
      updateOne: {
        /** The old value in the filter makes a concurrent change or a second run a no-op. */
        filter: { _id: change.id, tokenValue: change.before.tokenValue },
        update: {
          $set: {
            tokenValue: change.after.tokenValue,
            rate: change.after.rate,
            costCorrection: {
              id: HAIKU_TIER_CORRECTION_ID,
              runId,
              at,
              previousTokenValue: change.before.tokenValue,
              previousRate: change.before.rate,
            },
          },
        },
      },
    })),
    { session },
  );
  if (written.modifiedCount !== changes.length) {
    logger.warn(
      `[correctHaikuTierCosts] ${changes.length - written.modifiedCount} row(s) changed since the plan was made and were skipped`,
    );
  }
}

async function applyBuckets(buckets: BucketChange[], session?: mongoose.ClientSession) {
  if (buckets.length === 0) {
    return;
  }
  await mongoose.models.UsageBucket.bulkWrite(
    buckets.map((bucket) => ({
      updateOne: {
        filter: {
          tenantId: bucket.tenantId,
          scopeType: bucket.scopeType,
          scopeKey: bucket.scopeKey,
          periodStart: bucket.periodStart,
        },
        update: { $inc: { usedTokens: Math.round(bucket.credits) } },
      },
    })),
    { session },
  );
}

async function loadRows(options: CorrectionOptions): Promise<Row[]> {
  const model = { $regex: HAIKU_5_5_PATTERN.source, $options: 'i' };
  return mongoose.models.Transaction.find({
    tokenType: { $in: ['prompt', 'completion'] },
    service: { $in: ['openrouter', null] },
    $or: [{ model }, { modelKey: model }, { providerModelId: model }],
    ...(options.since && { createdAt: { $gte: options.since } }),
    ...(options.tenantId && { tenantId: options.tenantId }),
  })
    .sort({ createdAt: 1 })
    .lean<Row[]>();
}

async function loadBuckets(changes: RowChange[]): Promise<IUsageBucket[]> {
  if (changes.length === 0) {
    return [];
  }
  const tenants = [...new Set(changes.map((change) => change.tenantId))];
  const earliest = changes.reduce(
    (min, change) => (change.createdAt < min ? change.createdAt : min),
    changes[0].createdAt,
  );
  return mongoose.models.UsageBucket.find({
    tenantId: { $in: tenants },
    scopeType: { $in: [...CREDIT_SCOPES] },
    periodEnd: { $gt: earliest },
  }).lean<IUsageBucket[]>();
}

function writeAudit(
  file: string,
  result: CorrectionResult,
  options: CorrectionOptions,
  status: 'started' | 'completed',
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const note = {
    correction: HAIKU_TIER_CORRECTION_ID,
    status,
    ...result,
    options: {
      since: options.since?.toISOString(),
      tenantId: options.tenantId,
    },
    rollback:
      'Each change lists the previous tokenValue and rate (also kept on the row as costCorrection). ' +
      'Subtract each bucket credits from UsageBucket.usedTokens and rebuild the affected days to undo.',
  };
  fs.writeFileSync(file, JSON.stringify(note, null, 2));
}

/**
 * Reprices Claude Haiku 5.5 ledger rows with the tiered rates (a call whose prompt reaches the long-prompt
 * threshold is billed at the higher tier), adds the difference to the credit buckets the rows were counted
 * in, and rebuilds the affected daily rollups. A dry run computes and reports the same without writing.
 */
export async function correctHaikuTierCosts(options: CorrectionOptions): Promise<CorrectionResult> {
  const { pricing, dryRun = true, now = new Date() } = options;
  const runId = randomUUID();

  const plan = await runAsSystem(async () => {
    const rows = await loadRows(options);
    const rowPlan = planRowChanges(rows, pricing);
    const bucketPlan = planBucketChanges(rowPlan.changes, await loadBuckets(rowPlan.changes));
    return { rows, rowPlan, bucketPlan };
  });

  const days = [
    ...new Set(plan.rowPlan.changes.map((change) => dhakaDay(change.createdAt))),
  ].sort();
  const result: CorrectionResult = {
    runId,
    dryRun,
    rowsScanned: plan.rows.length,
    rowsChanged: plan.rowPlan.changes.length,
    rowsUnpaired: plan.rowPlan.rowsUnpaired,
    rowsAlreadyCorrect: plan.rowPlan.rowsAlreadyCorrect,
    slices: plan.rowPlan.slices,
    buckets: plan.bucketPlan.buckets,
    bucketsMissing: plan.bucketPlan.missing,
    days,
    changes: plan.rowPlan.changes,
  };

  if (dryRun || result.rowsChanged === 0) {
    return result;
  }

  if (options.auditDir) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    result.auditFile = path.join(
      options.auditDir,
      `${stamp}-${HAIKU_TIER_CORRECTION_ID}-${runId.slice(0, 8)}.json`,
    );
    writeAudit(result.auditFile, result, options, 'started');
  }

  await runAsSystem(async () => {
    const useTransactions = supportsTransactions();
    const byTenant = new Map<string, RowChange[]>();
    for (const change of plan.rowPlan.changes) {
      byTenant.set(change.tenantId, [...(byTenant.get(change.tenantId) ?? []), change]);
    }
    for (const changes of byTenant.values()) {
      for (const part of chunk(changes, CHUNK_SIZE)) {
        const buckets = planBucketChanges(part, await loadBuckets(part)).buckets;
        const run = async (session?: mongoose.ClientSession) => {
          await writeChunk(part, runId, now, session);
          await applyBuckets(buckets, session);
        };
        if (!useTransactions) {
          await run();
          continue;
        }
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(() => run(session));
        } finally {
          await session.endSession();
        }
      }
    }
    for (const day of days) {
      const check = await rebuildDay(day, now);
      if (!check.ok) {
        logger.warn(`[correctHaikuTierCosts] rollup for ${day} does not match the ledger`, check);
      }
    }
  });

  if (result.auditFile) {
    writeAudit(result.auditFile, result, options, 'completed');
  }
  return result;
}
