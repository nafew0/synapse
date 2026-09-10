/** A model the server currently offers, keyed the way the quota engine keys it. */
export interface QuotaModelSource {
  modelKey: string;
  /** The model as configured — the id a person recognises. `modelKey` is the
   *  engine's matcher output and can be a family or catch-all (`claude-`). */
  modelId: string;
  label: string;
}

export interface QuotaModelBucket {
  scopeType: string;
  scopeKey: string;
  usedTokens: number;
  reservedTokens: number;
  limit: number | null;
  remaining: number | null;
  utilization: number | null;
  blocked: boolean;
}

export interface QuotaModelLimit {
  modelKey: string;
  maxTokens: number | null;
}

/**
 * - `active`: offered by the server today.
 * - `retired`: no longer offered, but still holds usage this period.
 * - `unmatched`: carries a limit, yet is neither offered nor used — a limit
 *   that currently constrains nothing.
 */
export type QuotaModelStatus = 'active' | 'retired' | 'unmatched';

export interface QuotaModelRow {
  modelKey: string;
  /** Configured model ids drawing from this bucket; empty for retired and
   *  unmatched rows, which have no configuration left to name them. */
  modelIds: string[];
  label: string;
  status: QuotaModelStatus;
  usedTokens: number;
  reservedTokens: number;
  limit: number | null;
  remaining: number | null;
  utilization: number | null;
  blocked: boolean;
}

export interface BuildQuotaModelRowsParams {
  sources: QuotaModelSource[];
  buckets: QuotaModelBucket[];
  limits: QuotaModelLimit[];
}

const STATUS_ORDER: Record<QuotaModelStatus, number> = { active: 0, retired: 1, unmatched: 2 };

function emptyRow(
  modelKey: string,
  modelIds: string[],
  label: string,
  status: QuotaModelStatus,
  limit: number | null,
): QuotaModelRow {
  return {
    modelKey,
    modelIds,
    label,
    status,
    usedTokens: 0,
    reservedTokens: 0,
    limit,
    remaining: limit,
    utilization: limit == null || limit === 0 ? null : 0,
    blocked: limit === 0,
  };
}

function bucketRow(
  bucket: QuotaModelBucket,
  modelIds: string[],
  label: string,
  status: QuotaModelStatus,
): QuotaModelRow {
  return {
    modelKey: bucket.scopeKey,
    modelIds,
    label,
    status,
    usedTokens: bucket.usedTokens,
    reservedTokens: bucket.reservedTokens,
    limit: bucket.limit,
    remaining: bucket.remaining,
    utilization: bucket.utilization,
    blocked: bucket.blocked,
  };
}

/**
 * One row per model an institution admin can reason about: every model the
 * server offers (with or without usage), every model still holding usage this
 * period, and every limit that points at neither. Several specs can share one
 * quota key — the office agent and the Claude spec both run on
 * `claude-haiku-4-5` — so their labels are joined onto a single row, because
 * that is the single bucket they draw from.
 */
export function buildQuotaModelRows({
  sources,
  buckets,
  limits,
}: BuildQuotaModelRowsParams): QuotaModelRow[] {
  const offered = new Map<string, { labels: Set<string>; modelIds: Set<string> }>();
  for (const { modelKey, modelId, label } of sources) {
    if (!modelKey || !label) {
      continue;
    }
    const entry = offered.get(modelKey) ?? { labels: new Set(), modelIds: new Set() };
    entry.labels.add(label);
    if (modelId) {
      entry.modelIds.add(modelId);
    }
    offered.set(modelKey, entry);
  }

  const bucketByKey = new Map<string, QuotaModelBucket>();
  for (const bucket of buckets) {
    if (bucket.scopeType === 'model') {
      bucketByKey.set(bucket.scopeKey, bucket);
    }
  }

  const limitByKey = new Map<string, number | null>();
  for (const { modelKey, maxTokens } of limits) {
    limitByKey.set(modelKey, maxTokens);
  }

  const rows: QuotaModelRow[] = [];

  for (const [modelKey, { labels, modelIds }] of offered) {
    const label = Array.from(labels).join(' · ');
    const ids = Array.from(modelIds);
    const bucket = bucketByKey.get(modelKey);
    rows.push(
      bucket
        ? bucketRow(bucket, ids, label, 'active')
        : emptyRow(modelKey, ids, label, 'active', limitByKey.get(modelKey) ?? null),
    );
  }

  for (const [modelKey, bucket] of bucketByKey) {
    if (!offered.has(modelKey)) {
      rows.push(bucketRow(bucket, [], modelKey, 'retired'));
    }
  }

  for (const [modelKey, maxTokens] of limitByKey) {
    if (!offered.has(modelKey) && !bucketByKey.has(modelKey)) {
      rows.push(emptyRow(modelKey, [], modelKey, 'unmatched', maxTokens));
    }
  }

  return rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.usedTokens + b.reservedTokens - (a.usedTokens + a.reservedTokens) ||
      a.label.localeCompare(b.label),
  );
}
