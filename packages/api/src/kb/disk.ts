import mongoose from 'mongoose';
import { KbLimits, logger, runAsSystem } from '@librechat/data-schemas';
import type {
  KbMethods,
  IInstitution,
  IKbStorageDaily,
  KbTenantStorage,
  KbStorageFigures,
  IKbDocumentVersion,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Model, Types } from 'mongoose';
import type { KbFileStore } from './store';
import { dhakaDay } from '~/usage/rollup';

export const KB_STORAGE_DEFAULT_DAYS = 90;
export const KB_STORAGE_MAX_DAYS = 365;
/** The daily snapshot is attempted this often; it writes once per Asia/Dhaka day. */
export const KB_STORAGE_INTERVAL_MS: number = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_NAME = 'kb-storage';

export type KbStorageMethods = Pick<
  KbMethods,
  'measureKbStorage' | 'saveKbStorageDaily' | 'listKbStorageDaily' | 'listKbTenantIds'
>;

/** What callers see now: the recorded figures, the storage limit and when they were read. */
export interface KbStorageCurrent extends Omit<KbStorageFigures, 'unmeasuredVersions'> {
  limitBytes: number | null;
  measuredAt: string;
}

export interface KbStorageDay {
  day: string;
  documents: number;
  versions: number;
  originalBytes: number;
  parsedBytes: number;
  totalBytes: number;
}

export interface KbStorageView {
  current: KbStorageCurrent;
  daily: KbStorageDay[];
}

const toCurrent = (figures: KbStorageFigures, at: Date): KbStorageCurrent => ({
  documents: figures.documents,
  versions: figures.versions,
  originalBytes: figures.originalBytes,
  parsedBytes: figures.parsedBytes,
  indexChunks: figures.indexChunks,
  totalBytes: figures.totalBytes,
  limitBytes: KbLimits.maxTotalBytes,
  measuredAt: at.toISOString(),
});

const toDay = (row: IKbStorageDaily): KbStorageDay => ({
  day: row.day,
  documents: row.documents,
  versions: row.versions,
  originalBytes: row.originalBytes,
  parsedBytes: row.parsedBytes,
  totalBytes: row.totalBytes,
});

/** The first Asia/Dhaka day of a window of `days` days ending today. */
export const firstDayOf = (days: number, now: Date): string =>
  dhakaDay(new Date(now.getTime() - (days - 1) * DAY_MS));

/** `?days=`: a whole number from 1 to 365, 90 when absent; null when invalid. */
export function readStorageDays(value: unknown): number | null {
  if (value == null || value === '') {
    return KB_STORAGE_DEFAULT_DAYS;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > KB_STORAGE_MAX_DAYS) {
    return null;
  }
  return days;
}

const saveRows = (
  methods: Pick<KbStorageMethods, 'saveKbStorageDaily'>,
  rows: KbTenantStorage[],
  now: Date,
) =>
  methods.saveKbStorageDaily(rows.map((row) => ({ ...row, day: dhakaDay(now), measuredAt: now })));

/**
 * Measures one tenant and writes it as today's row, so the day reflects an upload, a new
 * version, a pruned version or a delete as soon as it happens. Never throws: the change it
 * follows already succeeded, and the daily job writes the day anyway.
 */
export async function recordKbStorage(
  methods: Pick<KbStorageMethods, 'measureKbStorage' | 'saveKbStorageDaily'>,
  tenantId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await runAsSystem(async () => {
      const rows = await methods.measureKbStorage(tenantId);
      await saveRows(methods, rows, now);
    });
  } catch (error) {
    logger.warn(
      `[kb/storage] could not record storage for ${tenantId}: ${(error as Error).message}`,
    );
  }
}

/** Writes today's row for every institution and every tenant with knowledge base records. */
export async function snapshotKbStorage(
  methods: KbStorageMethods,
  now: Date = new Date(),
): Promise<number> {
  return runAsSystem(async () => {
    const [tenants, measured] = await Promise.all([
      methods.listKbTenantIds(),
      methods.measureKbStorage(),
    ]);
    const byTenant = new Map(measured.map((row) => [row.tenantId, row]));
    const rows = tenants.map(
      (tenantId): KbTenantStorage =>
        byTenant.get(tenantId) ?? {
          tenantId,
          documents: 0,
          versions: 0,
          originalBytes: 0,
          parsedBytes: 0,
          indexChunks: 0,
          totalBytes: 0,
          unmeasuredVersions: 0,
        },
    );
    await saveRows(methods, rows, now);
    return rows.length;
  });
}

interface JobRow {
  name: string;
  lastDay?: string | null;
}

/**
 * Takes today's snapshot once per Asia/Dhaka day across all servers: the day is claimed with
 * one atomic update, and a failed snapshot gives the claim back. Returns whether it ran.
 */
export async function runDailyKbStorageSnapshot(
  methods: KbStorageMethods,
  now: Date = new Date(),
): Promise<boolean> {
  const day = dhakaDay(now);
  const UsageJob = mongoose.models.UsageJob as Model<JobRow>;
  await UsageJob.updateOne(
    { name: JOB_NAME },
    { $setOnInsert: { name: JOB_NAME } },
    { upsert: true },
  ).catch((error: { code?: number }) => {
    if (error.code !== 11000) {
      throw error;
    }
  });
  const claimed = await UsageJob.findOneAndUpdate(
    { name: JOB_NAME, lastDay: { $ne: day } },
    { $set: { lastDay: day, lastRunAt: now } },
  ).lean<JobRow>();
  if (!claimed) {
    return false;
  }
  try {
    const tenants = await snapshotKbStorage(methods, now);
    logger.info(`[kb/storage] daily snapshot for ${day}: ${tenants} tenant(s)`);
    return true;
  } catch (error) {
    await UsageJob.updateOne({ name: JOB_NAME }, { $set: { lastDay: claimed.lastDay ?? null } });
    throw error;
  }
}

/** Runs the daily snapshot now and then hourly. Returns a function that stops it. */
export function startKbStorageJob(
  methods: KbStorageMethods,
  intervalMs: number = KB_STORAGE_INTERVAL_MS,
): () => void {
  const tick = () =>
    void runDailyKbStorageSnapshot(methods).catch((error) =>
      logger.error('[kb/storage] daily snapshot failed', error),
    );
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** One tenant's figures now and its daily rows over the last `days` days, oldest first. */
export async function readKbStorage(
  methods: Pick<KbStorageMethods, 'measureKbStorage' | 'listKbStorageDaily'>,
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<KbStorageView> {
  const [[figures], rows] = await runAsSystem(() =>
    Promise.all([
      methods.measureKbStorage(tenantId),
      methods.listKbStorageDaily({ tenantId, fromDay: firstDayOf(days, now) }),
    ]),
  );
  return { current: toCurrent(figures, now), daily: rows.map(toDay) };
}

type InstitutionName = Pick<IInstitution, 'tenantId' | 'name' | 'status'>;

const findInstitutions = (filter: object): Promise<InstitutionName[]> =>
  runAsSystem(() =>
    (mongoose.models.Institution as Model<IInstitution>)
      .find(filter)
      .select('tenantId name status')
      .lean<InstitutionName[]>()
      .exec(),
  );

const sumFigures = (rows: KbStorageFigures[]): KbStorageFigures =>
  rows.reduce(
    (total, row) => ({
      documents: total.documents + row.documents,
      versions: total.versions + row.versions,
      originalBytes: total.originalBytes + row.originalBytes,
      parsedBytes: total.parsedBytes + row.parsedBytes,
      indexChunks: total.indexChunks + row.indexChunks,
      totalBytes: total.totalBytes + row.totalBytes,
      unmeasuredVersions: total.unmeasuredVersions + row.unmeasuredVersions,
    }),
    {
      documents: 0,
      versions: 0,
      originalBytes: 0,
      parsedBytes: 0,
      indexChunks: 0,
      totalBytes: 0,
      unmeasuredVersions: 0,
    },
  );

export interface KbStorageHandlers {
  /** `GET /api/platform/kb/storage?days=` */
  list: (req: Request, res: Response) => Promise<void>;
  /** `GET /api/platform/institutions/:tenantId/kb/storage?days=` */
  institution: (req: Request, res: Response) => Promise<void>;
}

/** Superadmin views of knowledge base storage across institutions. */
export function createKbStorageHandlers(deps: {
  methods: Pick<KbStorageMethods, 'measureKbStorage' | 'listKbStorageDaily'>;
  now?: () => Date;
}): KbStorageHandlers {
  const { methods } = deps;
  const clock = deps.now ?? (() => new Date());

  const withDays =
    (handler: (req: Request, res: Response, days: number, now: Date) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const days = readStorageDays(req.query.days);
      if (days == null) {
        res
          .status(400)
          .json({ error: `days must be a whole number from 1 to ${KB_STORAGE_MAX_DAYS}` });
        return;
      }
      try {
        await handler(req, res, days, clock());
      } catch (error) {
        logger.error('[kb/storage] request failed', error);
        res.status(500).json({ error: 'Knowledge base storage request failed' });
      }
    };

  const list = withDays(async (_req, res, days, now) => {
    const [institutions, measured, rows] = await Promise.all([
      findInstitutions({}),
      runAsSystem(() => methods.measureKbStorage()),
      runAsSystem(() => methods.listKbStorageDaily({ fromDay: firstDayOf(days, now) })),
    ]);
    const names = new Map(institutions.map((i) => [i.tenantId, i]));
    const trends = new Map<string, { day: string; totalBytes: number }[]>();
    for (const row of rows) {
      const trend = trends.get(row.tenantId) ?? [];
      trend.push({ day: row.day, totalBytes: row.totalBytes });
      trends.set(row.tenantId, trend);
    }
    const tenants = new Set([...names.keys(), ...measured.map((row) => row.tenantId)]);
    const byTenant = new Map(measured.map((row) => [row.tenantId, row]));
    const listed = [...tenants].map((tenantId) => {
      const figures = byTenant.get(tenantId) ?? sumFigures([]);
      return {
        tenantId,
        name: names.get(tenantId)?.name ?? null,
        status: names.get(tenantId)?.status ?? null,
        current: { ...toCurrent(figures, now), unmeasuredVersions: figures.unmeasuredVersions },
        trend: trends.get(tenantId) ?? [],
      };
    });
    listed.sort(
      (a, b) =>
        b.current.totalBytes - a.current.totalBytes ||
        String(a.name ?? a.tenantId).localeCompare(String(b.name ?? b.tenantId)),
    );
    const totals = sumFigures(measured);
    res.json({
      days,
      measuredAt: now.toISOString(),
      limitBytes: KbLimits.maxTotalBytes,
      totals,
      institutions: listed,
    });
  });

  const institution = withDays(async (req, res, days, now) => {
    const tenantId = String(req.params.tenantId ?? '');
    const [found] = tenantId ? await findInstitutions({ tenantId }) : [];
    if (!found) {
      res.status(404).json({ error: 'Institution not found' });
      return;
    }
    const view = await readKbStorage(methods, tenantId, days, now);
    res.json({ tenantId, name: found.name, days, ...view });
  });

  return { list, institution };
}

export interface KbStorageBackfill {
  versions: number;
  /** Versions whose recorded size differed from the file on disk, and were corrected. */
  corrected: number;
  /** Versions whose original is missing from disk; left as recorded. */
  missing: { tenantId: string; fileRef: string }[];
  /** Live versions without a parsed size: only re-indexing records it. */
  unmeasuredVersions: number;
  /** Tenants written as today's row; 0 on a dry run. */
  tenants: number;
}

type VersionFile = Pick<
  IKbDocumentVersion,
  '_id' | 'tenantId' | 'documentId' | 'version' | 'fileRef' | 'sizeBytes'
>;

/**
 * Checks every stored version's recorded size against its file on disk, corrects the ones that
 * differ (the document's own size too when it is the latest version), and writes today's
 * snapshot. Parsed sizes live only in the search index, so versions indexed before they were
 * recorded are counted, not filled.
 */
export async function backfillKbStorage({
  methods,
  store,
  dryRun = false,
  now = new Date(),
}: {
  methods: KbStorageMethods;
  store: Pick<KbFileStore, 'size'>;
  dryRun?: boolean;
  now?: Date;
}): Promise<KbStorageBackfill> {
  const versions = mongoose.models.KbDocumentVersion as Model<IKbDocumentVersion>;
  const documents = mongoose.models.KbDocument as Model<{ _id: Types.ObjectId }>;
  const result: KbStorageBackfill = {
    versions: 0,
    corrected: 0,
    missing: [],
    unmeasuredVersions: 0,
    tenants: 0,
  };
  await runAsSystem(async () => {
    const cursor = versions
      .find({})
      .select('tenantId documentId version fileRef sizeBytes')
      .lean<VersionFile[]>()
      .cursor();
    for await (const version of cursor as AsyncIterable<VersionFile>) {
      result.versions++;
      const size = await store.size(version.fileRef);
      if (size == null) {
        result.missing.push({ tenantId: version.tenantId, fileRef: version.fileRef });
        continue;
      }
      if (size === version.sizeBytes) {
        continue;
      }
      result.corrected++;
      if (dryRun) {
        continue;
      }
      await versions.updateOne({ _id: version._id }, { $set: { sizeBytes: size } });
      await documents.updateOne(
        { _id: version.documentId, latestVersion: version.version },
        { $set: { sizeBytes: size } },
      );
    }
  });
  const measured = await runAsSystem(() => methods.measureKbStorage());
  result.unmeasuredVersions = measured.reduce((sum, row) => sum + row.unmeasuredVersions, 0);
  if (!dryRun) {
    result.tenants = await snapshotKbStorage(methods, now);
  }
  return result;
}
