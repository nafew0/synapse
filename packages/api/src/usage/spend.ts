import { z } from 'zod';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { logger, runAsSystem, INDIVIDUAL_USAGE_ACCOUNT } from '@librechat/data-schemas';
import type {
  FixedCost,
  ICostSettings,
  IUsagePricing,
  UsagePricingFields,
  AuditMetadata,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { CREDITS_PER_USD, DEFAULT_USAGE_PRICING } from './packages';
import { dayStart, dhakaDay, nextDay, serviceOf } from './rollup';
import { buildAuditContext } from '~/admin/context';

/** Tenant key for users outside any institution. */
export const INDIVIDUALS_KEY: string = INDIVIDUAL_USAGE_ACCOUNT;
/** Tenant key for rows with neither an institution nor a user. */
export const PLATFORM_KEY: string = '__platform__';
/** Services paid out of the OpenRouter balance, so the top-up fee applies to them (voice is on that bill). */
export const OPENROUTER_BILLED: ReadonlySet<string> = new Set(['openrouter', 'stt']);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const MAX_PAGE = 200;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface Range {
  start: string;
  end: string;
  days: number;
}

const daysBetween = (start: string, end: string): number =>
  Math.round((dayStart(end).getTime() - dayStart(start).getTime()) / DAY_MS) + 1;

const shiftDay = (day: string, by: number): string =>
  dhakaDay(new Date(dayStart(day).getTime() + by * DAY_MS));

/** Inclusive Asia/Dhaka days from `start` to `end`; defaults to the last 30 days. Throws on a bad range. */
export function parseRange(
  query: { start?: unknown; end?: unknown },
  now: Date = new Date(),
): Range {
  const end = typeof query.end === 'string' && query.end ? query.end : dhakaDay(now);
  const start =
    typeof query.start === 'string' && query.start
      ? query.start
      : shiftDay(end, -(DEFAULT_RANGE_DAYS - 1));
  const valid = (day: string) => DAY_PATTERN.test(day) && !Number.isNaN(dayStart(day).getTime());
  if (!valid(start) || !valid(end) || start > end) {
    throw new RangeError('start and end must be YYYY-MM-DD days with start <= end');
  }
  const days = daysBetween(start, end);
  if (days > MAX_RANGE_DAYS) {
    throw new RangeError(`range is limited to ${MAX_RANGE_DAYS} days`);
  }
  return { start, end, days };
}

/** The equal-length window that ends the day before `range` starts. */
export const previousRange = (range: Range): Range => {
  const end = shiftDay(range.start, -1);
  return { start: shiftDay(end, -(range.days - 1)), end, days: range.days };
};

export interface Rates {
  bdtPerUsd: number;
  feePercent: number;
}

export interface Cost {
  /** What the ledger recorded (provider rate). */
  ledgerUsd: number;
  /** Top-up fee on OpenRouter-billed services. */
  feeUsd: number;
  /** `ledgerUsd + feeUsd`: what BdREN actually pays. */
  costUsd: number;
  costBdt: number;
  /** Part of `costUsd` that is user-driven work. */
  billableUsd: number;
  /** Part of `costUsd` that is our own cost (memory, indexing). */
  platformUsd: number;
  requests: number;
  units: number;
  pages: number;
  inputTokens: number;
  outputTokens: number;
}

interface Row {
  key: Record<string, string | boolean | undefined>;
  service: string;
  billable: boolean;
  costUsd: number;
  requests: number;
  units: number;
  pages: number;
  inputTokens: number;
  outputTokens: number;
}

const emptyCost = (): Cost => ({
  ledgerUsd: 0,
  feeUsd: 0,
  costUsd: 0,
  costBdt: 0,
  billableUsd: 0,
  platformUsd: 0,
  requests: 0,
  units: 0,
  pages: 0,
  inputTokens: 0,
  outputTokens: 0,
});

function addRow(cost: Cost, row: Row, rates: Rates): Cost {
  const fee = OPENROUTER_BILLED.has(row.service) ? (row.costUsd * rates.feePercent) / 100 : 0;
  const total = row.costUsd + fee;
  cost.ledgerUsd += row.costUsd;
  cost.feeUsd += fee;
  cost.costUsd += total;
  cost.costBdt = cost.costUsd * rates.bdtPerUsd;
  cost[row.billable ? 'billableUsd' : 'platformUsd'] += total;
  cost.requests += row.requests;
  cost.units += row.units;
  cost.pages += row.pages;
  cost.inputTokens += row.inputTokens;
  cost.outputTokens += row.outputTokens;
  return cost;
}

const sumRows = (rows: Row[], rates: Rates): Cost =>
  rows.reduce((cost, row) => addRow(cost, row, rates), emptyCost());

function groupBy<K extends string>(
  rows: Row[],
  keyOf: (row: Row) => K,
  rates: Rates,
): Map<K, Cost> {
  const groups = new Map<K, Cost>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, addRow(groups.get(key) ?? emptyCost(), row, rates));
  }
  return groups;
}

const round = (value: number, places = 6): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const roundCost = (cost: Cost): Cost => ({
  ...cost,
  ledgerUsd: round(cost.ledgerUsd),
  feeUsd: round(cost.feeUsd),
  costUsd: round(cost.costUsd),
  costBdt: round(cost.costBdt, 4),
  billableUsd: round(cost.billableUsd),
  platformUsd: round(cost.platformUsd),
});

/** Change against a previous figure, as a fraction; `null` when there was nothing before. */
const changeOf = (now: number, before: number): number | null =>
  before > 0 ? round((now - before) / before, 4) : null;

const tenantKeyOf = (tenantId: string | undefined, hasUser: boolean): string => {
  if (tenantId && tenantId !== INDIVIDUALS_KEY) {
    return tenantId;
  }
  return tenantId === INDIVIDUALS_KEY || hasUser ? INDIVIDUALS_KEY : PLATFORM_KEY;
};

const VIRTUAL_LABELS: Record<string, string> = {
  [INDIVIDUALS_KEY]: 'Individuals',
  [PLATFORM_KEY]: 'Platform / unattributed',
};

/** Display name of a tenant key: the two virtual keys, an institution name, or the raw id. */
const tenantLabel = (tenantId: string, known?: string): string =>
  VIRTUAL_LABELS[tenantId] ?? known ?? tenantId;

const tenantKind = (tenantId: string, known?: string): InstitutionRow['kind'] => {
  if (tenantId === INDIVIDUALS_KEY) {
    return 'individuals';
  }
  if (tenantId === PLATFORM_KEY) {
    return 'platform';
  }
  return known ? 'institution' : 'unknown';
};

const rangeMatch = (range: Range) => ({ day: { $gte: range.start, $lte: range.end } });

/** Mongo filter for one tenant key, including the two virtual ones. */
function tenantFilter(tenantId: string): Record<string, unknown> {
  if (tenantId === INDIVIDUALS_KEY) {
    return {
      $or: [{ tenantId: INDIVIDUALS_KEY }, { tenantId: null, user: { $ne: null } }],
    };
  }
  if (tenantId === PLATFORM_KEY) {
    return { tenantId: null, user: null };
  }
  return { tenantId };
}

type Dims = Record<string, unknown>;

async function aggregateDaily(
  range: Range,
  dims: Dims,
  extraMatch: Record<string, unknown> = {},
): Promise<Row[]> {
  const docs = await mongoose.models.UsageDaily.aggregate<{
    _id: Record<string, string | boolean | undefined> & { service: string; billable: boolean };
    costUsd: number;
    requests: number;
    units: number;
    pages: number;
    inputTokens: number;
    outputTokens: number;
  }>([
    { $match: { ...rangeMatch(range), ...extraMatch } },
    {
      $group: {
        _id: { ...dims, service: '$service', billable: '$billable' },
        costUsd: { $sum: '$costUsd' },
        requests: { $sum: '$requests' },
        units: { $sum: '$units' },
        pages: { $sum: '$pages' },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
      },
    },
  ]);
  return docs.map(({ _id, ...sums }) => {
    const { service, billable, ...key } = _id;
    return { key, service, billable, ...sums };
  });
}

const TENANT_DIMS = { tenantId: '$tenantId', hasUser: { $gt: ['$user', null] } };

const rowTenant = (row: Row): string =>
  tenantKeyOf(row.key.tenantId as string | undefined, row.key.hasUser === true);

/** Distinct active users per tenant key and overall in `range`. */
async function activeUsers(
  range: Range,
  extraMatch: Record<string, unknown> = {},
): Promise<{ total: number; byTenant: Map<string, number> }> {
  const pairs = await mongoose.models.UsageDaily.aggregate<{
    _id: { tenantId?: string; user?: unknown };
  }>([
    { $match: { $and: [rangeMatch(range), extraMatch, { user: { $ne: null } }] } },
    { $group: { _id: { tenantId: '$tenantId', user: '$user' } } },
  ]);
  const everyone = new Set<string>();
  const perTenant = new Map<string, Set<string>>();
  for (const { _id } of pairs) {
    const user = String(_id.user);
    const tenant = tenantKeyOf(_id.tenantId, true);
    everyone.add(user);
    perTenant.set(tenant, (perTenant.get(tenant) ?? new Set()).add(user));
  }
  return {
    total: everyone.size,
    byTenant: new Map([...perTenant].map(([tenant, users]) => [tenant, users.size])),
  };
}

const prorate = (settings: FixedCost[], rates: Rates, range: Range) => {
  const monthly = new Map<string, number>();
  for (let day = range.start, i = 0; i < range.days; day = nextDay(day), i += 1) {
    monthly.set(day.slice(0, 7), (monthly.get(day.slice(0, 7)) ?? 0) + 1);
  }
  const share = [...monthly].reduce((total, [month, covered]) => {
    const [year, number] = month.split('-').map(Number);
    return total + covered / new Date(Date.UTC(year, number, 0)).getUTCDate();
  }, 0);
  const items = settings.map((item) => {
    const monthlyUsd = item.currency === 'USD' ? item.amount : item.amount / rates.bdtPerUsd;
    return { ...item, monthlyUsd: round(monthlyUsd), periodUsd: round(monthlyUsd * share) };
  });
  const periodUsd = round(items.reduce((total, item) => total + item.periodUsd, 0));
  return { items, periodUsd, periodBdt: round(periodUsd * rates.bdtPerUsd, 4) };
};

export interface SpendDeps {
  getUsagePricing: () => Promise<IUsagePricing | null>;
  saveUsagePricing: (fields: UsagePricingFields, actorId?: string | null) => Promise<IUsagePricing>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
}

const settingsBody = z
  .object({
    bdtPerUsd: z.number().min(1).max(10_000).optional(),
    providerFeePercent: z.number().min(0).max(100).optional(),
    fixedCosts: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(60).optional(),
          label: z.string().trim().min(1).max(120),
          amount: z.number().min(0).max(1e9),
          currency: z.enum(['USD', 'BDT']),
        }),
      )
      .max(50)
      .refine(
        (items) =>
          new Set(items.map((i) => i.id).filter(Boolean)).size === items.filter((i) => i.id).length,
        'Duplicate id',
      )
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No fields to update');

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const toCsv = (header: string[], lines: unknown[][]): string =>
  [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';

const first = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const SORTS: Record<string, (a: InstitutionRow, b: InstitutionRow) => number> = {
  cost: (a, b) => b.cost.costUsd - a.cost.costUsd,
  members: (a, b) => b.activeMembers - a.activeMembers,
  requests: (a, b) => b.cost.requests - a.cost.requests,
  change: (a, b) => (b.changeVsPrevious ?? -1e12) - (a.changeVsPrevious ?? -1e12),
  name: (a, b) => a.name.localeCompare(b.name),
};

interface InstitutionRow {
  tenantId: string;
  name: string;
  kind: 'institution' | 'individuals' | 'platform' | 'unknown';
  cost: Cost;
  byService: Record<string, number>;
  activeMembers: number;
  costPerActiveMember: number | null;
  topModel: string | null;
  previousCostUsd: number;
  changeVsPrevious: number | null;
  shareOfTotal: number;
}

type SpendHandler = (req: ServerRequest, res: Response) => Promise<void>;

export interface SpendHandlers {
  summary: SpendHandler;
  institutions: SpendHandler;
  institution: SpendHandler;
  services: SpendHandler;
  timeseries: SpendHandler;
  members: SpendHandler;
  requests: SpendHandler;
  exportCsv: SpendHandler;
  getSettings: SpendHandler;
  updateSettings: SpendHandler;
}

export function createSpendHandlers(deps: SpendDeps): SpendHandlers {
  async function loadRates(): Promise<Rates> {
    const saved = await deps.getUsagePricing();
    return {
      bdtPerUsd: saved?.bdtPerUsd ?? DEFAULT_USAGE_PRICING.bdtPerUsd,
      feePercent: saved?.providerFeePercent ?? DEFAULT_USAGE_PRICING.providerFeePercent,
    };
  }

  async function loadFixed(): Promise<FixedCost[]> {
    const settings = await mongoose.models.CostSettings.findOne({
      key: 'default',
    }).lean<ICostSettings>();
    return settings?.fixedCosts ?? [];
  }

  async function names(tenantIds: string[]): Promise<Map<string, string>> {
    const found = await mongoose.models.Institution.find({ tenantId: { $in: tenantIds } })
      .select('tenantId name')
      .lean<{ tenantId: string; name: string }[]>();
    return new Map(found.map((item) => [item.tenantId, item.name]));
  }

  const rangeMeta = (rates: Rates, range: Range) => ({
    ...range,
    timezone: 'Asia/Dhaka',
    bdtPerUsd: rates.bdtPerUsd,
    providerFeePercent: rates.feePercent,
  });

  const byService = (rows: Row[], rates: Rates): Record<string, number> =>
    Object.fromEntries(
      [...groupBy(rows, (row) => row.service, rates)].map(([service, cost]) => [
        service,
        round(cost.costUsd),
      ]),
    );

  function wrap(
    label: string,
    run: (req: ServerRequest, res: Response) => Promise<unknown>,
  ): SpendHandler {
    return async (req: ServerRequest, res: Response): Promise<void> => {
      try {
        await run(req, res);
      } catch (error) {
        if (error instanceof RangeError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error(`[Costs] ${label} failed`, error);
        res.status(500).json({ error: `Failed to load ${label}` });
      }
    };
  }

  const query = (req: ServerRequest) => req.query as Record<string, unknown>;

  async function summaryData(range: Range, rates: Rates) {
    const [rows, active] = await Promise.all([aggregateDaily(range, {}), activeUsers(range)]);
    const cost = roundCost(sumRows(rows, rates));
    return {
      cost,
      byService: byService(rows, rates),
      activeUsers: active.total,
      costPerActiveUser: active.total ? round(cost.costUsd / active.total) : null,
    };
  }

  const summary = wrap('summary', async (req, res) => {
    const range = parseRange(query(req));
    const previous = previousRange(range);
    const rates = await loadRates();
    const [current, before, fixedItems] = await Promise.all([
      summaryData(range, rates),
      summaryData(previous, rates),
      loadFixed(),
    ]);
    const fixed = prorate(fixedItems, rates, range);
    const grandUsd = round(current.cost.costUsd + fixed.periodUsd);
    res.json({
      range: rangeMeta(rates, range),
      current,
      previous: { range: previous, ...before },
      change: {
        costUsd: changeOf(current.cost.costUsd, before.cost.costUsd),
        activeUsers: changeOf(current.activeUsers, before.activeUsers),
        costPerActiveUser:
          current.costPerActiveUser != null && before.costPerActiveUser != null
            ? changeOf(current.costPerActiveUser, before.costPerActiveUser)
            : null,
      },
      fixed,
      grandTotal: { usd: grandUsd, bdt: round(grandUsd * rates.bdtPerUsd, 4) },
    });
  });

  async function institutionRows(range: Range, rates: Rates): Promise<InstitutionRow[]> {
    const previous = previousRange(range);
    const [rows, before, active] = await Promise.all([
      aggregateDaily(range, { ...TENANT_DIMS, modelKey: '$modelKey' }),
      aggregateDaily(previous, TENANT_DIMS),
      activeUsers(range),
    ]);
    const perTenant = groupBy(rows, rowTenant, rates);
    const prevTenant = groupBy(before, rowTenant, rates);
    const keys = new Set([...perTenant.keys(), ...prevTenant.keys()]);
    const labels = await names([...keys]);
    const total = [...perTenant.values()].reduce((sum, cost) => sum + cost.costUsd, 0);
    return [...keys].map((tenantId) => {
      const tenantRows = rows.filter((row) => rowTenant(row) === tenantId);
      const cost = roundCost(perTenant.get(tenantId) ?? emptyCost());
      const models = groupBy(
        tenantRows.filter((row) => row.service === 'openrouter'),
        (row) => String(row.key.modelKey ?? 'unknown'),
        rates,
      );
      const top = [...models].sort((a, b) => b[1].costUsd - a[1].costUsd)[0];
      const members = active.byTenant.get(tenantId) ?? 0;
      const prior = prevTenant.get(tenantId)?.costUsd ?? 0;
      const name = labels.get(tenantId);
      return {
        tenantId,
        name: tenantLabel(tenantId, name),
        kind: tenantKind(tenantId, name),
        cost,
        byService: byService(tenantRows, rates),
        activeMembers: members,
        costPerActiveMember: members ? round(cost.costUsd / members) : null,
        topModel: top?.[0] ?? null,
        previousCostUsd: round(prior),
        changeVsPrevious: changeOf(cost.costUsd, prior),
        shareOfTotal: total ? round(cost.costUsd / total, 4) : 0,
      } satisfies InstitutionRow;
    });
  }

  const institutions = wrap('institutions', async (req, res) => {
    const range = parseRange(query(req));
    const rates = await loadRates();
    const sort = SORTS[first(query(req).sort) ?? 'cost'] ?? SORTS.cost;
    const list = (await institutionRows(range, rates)).sort(sort);
    res.json({ range: rangeMeta(rates, range), institutions: list });
  });

  const services = wrap('services', async (req, res) => {
    const range = parseRange(query(req));
    const rates = await loadRates();
    const rows = await aggregateDaily(range, TENANT_DIMS);
    const labels = await names([...new Set(rows.map(rowTenant))]);
    const perService = [...groupBy(rows, (row) => row.service, rates)];
    const list = perService
      .map(([service, cost]) => {
        const top = [
          ...groupBy(
            rows.filter((row) => row.service === service),
            rowTenant,
            rates,
          ),
        ]
          .sort((a, b) => b[1].costUsd - a[1].costUsd)
          .slice(0, 5)
          .map(([tenantId, tenantCost]) => ({
            tenantId,
            name: tenantLabel(tenantId, labels.get(tenantId)),
            costUsd: round(tenantCost.costUsd),
            units: tenantCost.units,
          }));
        return { service, ...roundCost(cost), topInstitutions: top };
      })
      .sort((a, b) => b.costUsd - a.costUsd);
    res.json({ range: rangeMeta(rates, range), services: list });
  });

  const timeseries = wrap('timeseries', async (req, res) => {
    const range = parseRange(query(req));
    const groupKey = first(query(req).groupBy) ?? 'service';
    if (groupKey !== 'service' && groupKey !== 'institution') {
      res.status(400).json({ error: 'groupBy must be service or institution' });
      return;
    }
    const rates = await loadRates();
    const rows = await aggregateDaily(range, { day: '$day', ...TENANT_DIMS });
    const days: string[] = [];
    for (let day = range.start, i = 0; i < range.days; day = nextDay(day), i += 1) {
      days.push(day);
    }
    const index = new Map(days.map((day, i) => [day, i]));
    const keyOf = (row: Row) => (groupKey === 'service' ? row.service : rowTenant(row));
    const series = new Map<string, number[]>();
    for (const row of rows) {
      const values = series.get(keyOf(row)) ?? days.map(() => 0);
      const fee = OPENROUTER_BILLED.has(row.service) ? 1 + rates.feePercent / 100 : 1;
      values[index.get(row.key.day as string) ?? 0] += row.costUsd * fee;
      series.set(keyOf(row), values);
    }
    const labels = groupKey === 'institution' ? await names([...series.keys()]) : new Map();
    res.json({
      range: rangeMeta(rates, range),
      groupBy: groupKey,
      days,
      series: [...series]
        .map(([key, values]) => ({
          key,
          label: tenantLabel(key, labels.get(key)),
          values: values.map((value) => round(value)),
          totalUsd: round(values.reduce((sum, value) => sum + value, 0)),
        }))
        .sort((a, b) => b.totalUsd - a.totalUsd),
    });
  });

  async function memberRows(range: Range, rates: Rates, tenantId?: string, limit = 2000) {
    const rows = await aggregateDaily(
      range,
      { user: '$user', ...TENANT_DIMS },
      tenantId ? tenantFilter(tenantId) : {},
    );
    const perMember = new Map<string, { user: string; tenantId: string; rows: Row[] }>();
    for (const row of rows) {
      const user = String(row.key.user ?? '');
      const tenant = rowTenant(row);
      const entry = perMember.get(`${user}|${tenant}`) ?? { user, tenantId: tenant, rows: [] };
      entry.rows.push(row);
      perMember.set(`${user}|${tenant}`, entry);
    }
    const ranked = [...perMember.values()]
      .map((entry) => ({ ...entry, cost: sumRows(entry.rows, rates) }))
      .sort((a, b) => b.cost.costUsd - a.cost.costUsd);
    const kept = ranked.slice(0, limit);
    const ids = [...new Set(kept.map((entry) => entry.user).filter(Boolean))];
    const users = await runAsSystem(async () =>
      mongoose.models.User.find({ _id: { $in: ids } })
        .select('name email')
        .lean<{ _id: unknown; name?: string; email?: string }[]>(),
    );
    const info = new Map(users.map((user) => [String(user._id), user]));
    return {
      total: ranked.length,
      members: kept.map((entry) => ({
        user: entry.user || null,
        name: info.get(entry.user)?.name ?? null,
        email: info.get(entry.user)?.email ?? null,
        tenantId: entry.tenantId,
        ...roundCost(entry.cost),
        byService: byService(entry.rows, rates),
      })),
    };
  }

  const members = wrap('members', async (req, res) => {
    const range = parseRange(query(req));
    const rates = await loadRates();
    const limit = Math.min(Math.max(Number(query(req).limit) || 500, 1), 2000);
    const { members: list, total } = await memberRows(
      range,
      rates,
      first(query(req).tenantId),
      limit,
    );
    res.json({ range: rangeMeta(rates, range), members: list, total });
  });

  const institution = wrap('institution', async (req, res) => {
    const range = parseRange(query(req));
    const tenantId = (req.params as { tenantId?: string }).tenantId ?? '';
    const rates = await loadRates();
    const match = tenantFilter(tenantId);
    const [rows, perDay, list, active] = await Promise.all([
      aggregateDaily(range, { modelKey: '$modelKey' }, match),
      aggregateDaily(range, { day: '$day' }, match),
      memberRows(range, rates, tenantId, 500).then((result) => result.members),
      activeUsers(range, match),
    ]);
    if (rows.length === 0) {
      const known = await names([tenantId]);
      if (!known.has(tenantId) && tenantId !== INDIVIDUALS_KEY && tenantId !== PLATFORM_KEY) {
        res.status(404).json({ error: 'No cost data for this institution' });
        return;
      }
    }
    const cost = roundCost(sumRows(rows, rates));
    const labels = await names([tenantId]);
    res.json({
      range: rangeMeta(rates, range),
      tenantId,
      name: tenantLabel(tenantId, labels.get(tenantId)),
      cost,
      activeMembers: active.total,
      byService: byService(rows, rates),
      byModel: [
        ...groupBy(
          rows.filter((row) => row.service === 'openrouter'),
          (row) => `${row.service}|${String(row.key.modelKey ?? '')}`,
          rates,
        ),
      ]
        .map(([key, value]) => {
          const [service, model] = key.split('|');
          return { service, model: model || null, ...roundCost(value) };
        })
        .sort((a, b) => b.costUsd - a.costUsd),
      byMember: list,
      byDay: [...groupBy(perDay, (row) => String(row.key.day), rates)]
        .map(([day, value]) => ({ day, ...roundCost(value) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    });
  });

  const requests = wrap('requests', async (req, res) => {
    const params = query(req);
    const range = parseRange(params);
    const filter: Record<string, unknown> = {
      createdAt: { $gte: dayStart(range.start), $lt: dayStart(nextDay(range.end)) },
    };
    const tenantId = first(params.tenantId);
    if (tenantId) {
      Object.assign(filter, tenantFilter(tenantId));
    }
    const user = first(params.user);
    if (user) {
      if (!mongoose.isValidObjectId(user)) {
        res.status(400).json({ error: 'user must be an id' });
        return;
      }
      filter.user = new mongoose.Types.ObjectId(user);
    }
    const before = first(params.before);
    if (before) {
      if (!mongoose.isValidObjectId(before)) {
        res.status(400).json({ error: 'before must be an id' });
        return;
      }
      filter._id = { $lt: new mongoose.Types.ObjectId(before) };
    }
    const service = first(params.service);
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), MAX_PAGE);
    const stages: mongoose.PipelineStage[] = [{ $match: filter }];
    if (service) {
      stages.push({ $match: { $expr: { $eq: [serviceOf, { $literal: service }] } } });
    }
    stages.push({ $sort: { _id: -1 } }, { $limit: limit + 1 });
    const found = await runAsSystem(async () =>
      mongoose.models.Transaction.aggregate<{
        _id: mongoose.Types.ObjectId;
        user: mongoose.Types.ObjectId;
        tenantId?: string;
        conversationId?: string;
        messageId?: string;
        modelKey?: string;
        usageKind?: string;
        taskType?: string;
        billable?: boolean;
        tokenType?: string;
        rawAmount?: number;
        pages?: number;
        tokenValue?: number;
        createdAt: Date;
      }>(stages),
    );
    const rates = await loadRates();
    const page = found.slice(0, limit);
    res.json({
      range: rangeMeta(rates, range),
      requests: page.map((row) => {
        const ledgerUsd = -(row.tokenValue ?? 0) / CREDITS_PER_USD;
        return {
          id: String(row._id),
          createdAt: row.createdAt,
          user: String(row.user),
          tenantId: row.tenantId ?? null,
          conversationId: row.conversationId ?? null,
          messageId: row.messageId ?? null,
          service: ((row as { service?: string }).service ?? null) as string | null,
          model: row.modelKey ?? null,
          usageKind: row.usageKind ?? null,
          taskType: row.taskType ?? null,
          billable: row.billable ?? true,
          tokenType: row.tokenType ?? null,
          units: Math.abs(row.rawAmount ?? 0),
          pages: row.pages ?? 0,
          ledgerUsd: round(ledgerUsd),
        };
      }),
      next: found.length > limit ? String(page[page.length - 1]._id) : null,
    });
  });

  const SHEETS = ['institutions', 'members', 'daily'] as const;

  const exportCsv = wrap('export', async (req, res) => {
    const range = parseRange(query(req));
    const sheet = first(query(req).sheet) ?? 'institutions';
    if (!(SHEETS as readonly string[]).includes(sheet)) {
      res.status(400).json({ error: `sheet must be one of ${SHEETS.join(', ')}` });
      return;
    }
    const rates = await loadRates();
    let body = '';
    if (sheet === 'institutions') {
      const list = (await institutionRows(range, rates)).sort(SORTS.cost);
      const serviceNames = [...new Set(list.flatMap((item) => Object.keys(item.byService)))].sort();
      body = toCsv(
        [
          'tenantId',
          'name',
          'costUsd',
          'costBdt',
          'feeUsd',
          'billableUsd',
          'platformUsd',
          'requests',
          'activeMembers',
          'costPerActiveMemberUsd',
          ...serviceNames.map((s) => `${s}Usd`),
        ],
        list.map((item) => [
          item.tenantId,
          item.name,
          item.cost.costUsd,
          item.cost.costBdt,
          item.cost.feeUsd,
          item.cost.billableUsd,
          item.cost.platformUsd,
          item.cost.requests,
          item.activeMembers,
          item.costPerActiveMember,
          ...serviceNames.map((s) => item.byService[s] ?? 0),
        ]),
      );
    } else if (sheet === 'members') {
      const { members: list } = await memberRows(range, rates, undefined, 20000);
      const serviceNames = [...new Set(list.flatMap((item) => Object.keys(item.byService)))].sort();
      body = toCsv(
        [
          'user',
          'name',
          'email',
          'tenantId',
          'costUsd',
          'costBdt',
          'requests',
          ...serviceNames.map((s) => `${s}Usd`),
        ],
        list.map((item) => [
          item.user,
          item.name,
          item.email,
          item.tenantId,
          item.costUsd,
          item.costBdt,
          item.requests,
          ...serviceNames.map((s) => item.byService[s] ?? 0),
        ]),
      );
    } else {
      const rows = await aggregateDaily(range, { day: '$day' });
      const perDay = [...groupBy(rows, (row) => String(row.key.day), rates)].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      body = toCsv(
        ['day', 'costUsd', 'costBdt', 'feeUsd', 'billableUsd', 'platformUsd', 'requests'],
        perDay.map(([day, cost]) => [
          day,
          round(cost.costUsd),
          round(cost.costBdt, 4),
          round(cost.feeUsd),
          round(cost.billableUsd),
          round(cost.platformUsd),
          cost.requests,
        ]),
      );
    }
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="costs-${sheet}-${range.start}_${range.end}.csv"`,
      })
      .send(body);
  });

  async function settingsView() {
    const [saved, rates, fixed] = await Promise.all([
      deps.getUsagePricing(),
      loadRates(),
      loadFixed(),
    ]);
    return {
      bdtPerUsd: rates.bdtPerUsd,
      providerFeePercent: rates.feePercent,
      configured: saved != null,
      fixedCosts: fixed,
      updatedAt: saved?.updatedAt ? new Date(saved.updatedAt).toISOString() : null,
    };
  }

  const getSettings = wrap('settings', async (_req, res) => {
    res.json({ settings: await settingsView() });
  });

  async function updateSettings(req: ServerRequest, res: Response): Promise<void> {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid request', issues: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const before = await settingsView();
      const input = parsed.data;
      const actorId = req.user?.id ?? req.user?._id?.toString() ?? null;
      if (input.bdtPerUsd != null || input.providerFeePercent != null) {
        const saved = await deps.getUsagePricing();
        await deps.saveUsagePricing(
          {
            defaultWeeklyPercent:
              saved?.defaultWeeklyPercent ?? DEFAULT_USAGE_PRICING.defaultWeeklyPercent,
            bdtPerUsd: input.bdtPerUsd ?? before.bdtPerUsd,
            providerFeePercent: input.providerFeePercent ?? before.providerFeePercent,
          },
          actorId,
        );
      }
      if (input.fixedCosts) {
        const fixedCosts = input.fixedCosts.map((item) => ({
          ...item,
          id: item.id ?? crypto.randomUUID(),
        }));
        await mongoose.models.CostSettings.findOneAndUpdate(
          { key: 'default' },
          { $set: { fixedCosts, updatedBy: actorId } },
          { upsert: true, setDefaultsOnInsert: true },
        );
      }
      const after = await settingsView();
      const metadata: AuditMetadata = {
        bdtPerUsd: after.bdtPerUsd,
        previous_bdtPerUsd: before.bdtPerUsd,
        providerFeePercent: after.providerFeePercent,
        previous_providerFeePercent: before.providerFeePercent,
        fixedCosts: JSON.stringify(after.fixedCosts),
        previous_fixedCosts: JSON.stringify(before.fixedCosts),
      };
      await deps.recordAuditEntry(
        {
          action: 'platform.cost_settings_updated',
          severity: 'warning',
          actor: {
            type: 'user',
            id: actorId ?? undefined,
            name: req.user?.name || req.user?.email || 'platform-superadmin',
          },
          target: { type: 'cost_settings', id: 'default', name: 'Cost settings' },
          metadata,
          context: buildAuditContext(req),
          tenantId: undefined,
        },
        { failClosed: true },
      );
      res.json({ settings: after });
    } catch (error) {
      logger.error('[Costs] settings update failed', error);
      res.status(500).json({ error: 'Failed to save cost settings' });
    }
  }

  return {
    summary,
    institutions,
    institution,
    services,
    timeseries,
    members,
    requests,
    exportCsv,
    getSettings,
    updateSettings,
  };
}
