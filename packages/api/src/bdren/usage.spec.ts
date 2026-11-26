import mongoose from 'mongoose';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MemberReport } from './usage';
import type { BdrenConfig } from './types';
import { backfillBdrenUsage, buildDay, postReport, runUsageExport, windowReports } from './usage';
import { readBdrenConfig } from './config';

const ISSUER = 'https://auth.bdren.test';
const KEY = 'bdren_prod_synapse_test';
const NOW = new Date('2026-11-14T05:00:00Z');

const config: BdrenConfig = readBdrenConfig({
  BDREN_API_URL: 'http://bdren.test',
  BDREN_PRODUCT_KEY: KEY,
  BDREN_ISSUER: ISSUER,
  BDREN_USAGE_EXPORT_ENABLED: 'true',
  BDREN_ALLOWANCE_ENABLED: 'true',
} as NodeJS.ProcessEnv);

let mongoServer: MongoMemoryServer;
let linked: mongoose.Types.ObjectId;
let linkedSubject: string;
let unlinked: mongoose.Types.ObjectId;
let strangerIssuer: mongoose.Types.ObjectId;
let counter = 0;

interface Stored {
  day: string;
  subject: string;
  task: string;
  credits: number;
}

/** An in-process bdren.ai: checks the key, replaces a member's day on every request, can be told to fail. */
function fakeBdren() {
  const rows: Stored[] = [];
  const windows: Array<{ subject: string; window: string; used: number }> = [];
  const state = { failures: [] as number[], calls: 0, keys: [] as Array<string | undefined> };
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    state.calls += 1;
    const headers = init.headers as Record<string, string>;
    state.keys.push(headers['X-Product-Api-Key']);
    const status = state.failures.shift();
    if (status) {
      return new Response('{}', { status });
    }
    if (headers['X-Product-Api-Key'] !== KEY) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    const body = JSON.parse(init.body as string) as { day: string; members: MemberReport[] };
    for (const member of body.members) {
      if (member.tasks) {
        const keep = rows.filter(
          (row) => !(row.day === body.day && row.subject === member.zitadel_subject),
        );
        rows.length = 0;
        rows.push(
          ...keep,
          ...member.tasks.map((task) => ({
            day: body.day,
            subject: member.zitadel_subject,
            task: task.task_type,
            credits: task.credits,
          })),
        );
      }
      for (const item of member.allowance ?? []) {
        windows.push({ subject: member.zitadel_subject, window: item.window, used: item.used });
      }
    }
    return new Response(
      JSON.stringify({ members_stored: body.members.length, unknown_members: [] }),
      { status: 200 },
    );
  };
  return { fetchFn, rows, windows, state };
}

const noSleep = async () => undefined;

async function seed(day: string, user: mongoose.Types.ObjectId, over: Record<string, unknown>) {
  counter += 1;
  await mongoose.models.UsageDaily.create({
    key: `k${counter}`,
    day,
    user,
    service: 'openrouter',
    billable: true,
    requests: 1,
    pages: 0,
    costUsd: 0.001,
    rows: 1,
    ...over,
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  linked = new mongoose.Types.ObjectId();
  unlinked = new mongoose.Types.ObjectId();
  strangerIssuer = new mongoose.Types.ObjectId();
  linkedSubject = 'sub-linked';
  await mongoose.models.User.collection.insertMany([
    { _id: linked, openidId: linkedSubject, openidIssuer: `${ISSUER}/`, email: 'a@x.test' },
    { _id: unlinked, email: 'b@x.test' },
    { _id: strangerIssuer, openidId: 'sub-other', openidIssuer: 'https://elsewhere.test' },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.UsageDaily.deleteMany({});
  await mongoose.models.UsageJob.deleteMany({});
  await mongoose.models.BdrenAllowance.deleteMany({});
  await mongoose.models.UsageBucket.deleteMany({});
});

describe('buildDay', () => {
  it('sums credits per linked member and task type, billable rows only', async () => {
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 0.0012, requests: 3 });
    await seed('2026-11-13', linked, {
      taskType: 'chat',
      costUsd: 0.0003,
      requests: 1,
      modelKey: 'x',
    });
    await seed('2026-11-13', linked, { taskType: 'scan_to_word', costUsd: 0.005, pages: 12 });
    await seed('2026-11-13', linked, {
      service: 'unstructured',
      costUsd: 0.002,
      taskType: undefined,
    });
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 9, billable: false });
    await seed('2026-11-12', linked, { taskType: 'chat', costUsd: 7 });
    const members = await buildDay('2026-11-13', ISSUER);
    expect(members).toEqual([
      {
        issuer: ISSUER,
        zitadel_subject: linkedSubject,
        tasks: [
          { task_type: 'chat', credits: 1500, requests: 4, pages: 0 },
          { task_type: 'other', credits: 2000, requests: 1, pages: 0 },
          { task_type: 'scan_to_word', credits: 5000, requests: 1, pages: 12 },
        ],
      },
    ]);
  });

  it('leaves out users without a bdren.ai identity and users of another issuer', async () => {
    await seed('2026-11-13', unlinked, { taskType: 'chat' });
    await seed('2026-11-13', strangerIssuer, { taskType: 'chat' });
    await seed('2026-11-13', undefined as never, { taskType: 'chat' });
    expect(await buildDay('2026-11-13', ISSUER)).toEqual([]);
  });

  it('turns an odd task name into one bdren.ai accepts', async () => {
    await seed('2026-11-13', linked, { taskType: 'Read Doc/2' });
    const [member] = await buildDay('2026-11-13', ISSUER);
    expect(member.tasks?.[0].task_type).toBe('read_doc_2');
  });
});

describe('buildDay merging', () => {
  it('merges task names that sanitise alike and users sharing one bdren.ai identity', async () => {
    const twin = new mongoose.Types.ObjectId();
    await mongoose.models.User.collection.insertOne({
      _id: twin,
      openidId: linkedSubject,
      openidIssuer: ISSUER,
    });
    await seed('2026-11-13', linked, { taskType: 'Chat', costUsd: 0.001, requests: 2 });
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 0.002, requests: 1 });
    await seed('2026-11-13', twin, { taskType: 'chat', costUsd: 0.004, requests: 5 });
    const members = await buildDay('2026-11-13', ISSUER);
    expect(members).toHaveLength(1);
    expect(members[0].tasks).toEqual([{ task_type: 'chat', credits: 7000, requests: 8, pages: 0 }]);
    await mongoose.models.User.deleteOne({ _id: twin });
  });
});

describe('postReport', () => {
  it('sends the product key and retries a 503 and a timeout, then succeeds', async () => {
    const bdren = fakeBdren();
    bdren.state.failures = [503, 429];
    const summary = await postReport(
      { config, fetchFn: bdren.fetchFn, sleep: noSleep },
      '2026-11-13',
      [{ issuer: ISSUER, zitadel_subject: 's', tasks: [] }],
    );
    expect(summary.stored).toBe(1);
    expect(bdren.state.calls).toBe(3);
    expect(new Set(bdren.state.keys)).toEqual(new Set([KEY]));
  });

  it('gives up after three attempts', async () => {
    const bdren = fakeBdren();
    bdren.state.failures = [500, 500, 500];
    await expect(
      postReport({ config, fetchFn: bdren.fetchFn, sleep: noSleep }, '2026-11-13', []),
    ).rejects.toThrow('could not take');
    expect(bdren.state.calls).toBe(3);
  });

  it('does not retry a refusal such as a wrong key', async () => {
    const bdren = fakeBdren();
    const wrong = { ...config, productKey: 'nope' };
    await expect(
      postReport({ config: wrong, fetchFn: bdren.fetchFn, sleep: noSleep }, '2026-11-13', []),
    ).rejects.toThrow('refused');
    expect(bdren.state.calls).toBe(1);
  });
});

describe('runUsageExport', () => {
  it('does nothing unless the export is switched on', async () => {
    const bdren = fakeBdren();
    const off = { ...config, usageExport: false };
    const run = await runUsageExport({
      config: off,
      fetchFn: bdren.fetchFn,
      sleep: noSleep,
      now: NOW,
    });
    expect(run.skipped).toBe('disabled');
    expect(bdren.state.calls).toBe(0);
  });

  it('sends yesterday and today, and sending again leaves the same totals', async () => {
    const bdren = fakeBdren();
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 0.001 });
    await seed('2026-11-14', linked, { taskType: 'chat', costUsd: 0.002 });
    const deps = { config, fetchFn: bdren.fetchFn, sleep: noSleep, now: NOW };
    const first = await runUsageExport(deps);
    expect(first.days.map((d) => d.day)).toEqual(['2026-11-13', '2026-11-14']);
    const before = JSON.stringify(bdren.rows);
    await runUsageExport({ ...deps, now: new Date(NOW.getTime() + 3_600_000) });
    expect(JSON.stringify(bdren.rows)).toBe(before);
    expect(bdren.rows).toEqual([
      { day: '2026-11-13', subject: linkedSubject, task: 'chat', credits: 1000 },
      { day: '2026-11-14', subject: linkedSubject, task: 'chat', credits: 2000 },
    ]);
  });

  it('a failed day stops the run, and the next run catches up every missed day', async () => {
    const bdren = fakeBdren();
    const deps = { config, fetchFn: bdren.fetchFn, sleep: noSleep };
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      await seed(day, linked, { taskType: 'chat', costUsd: 0.001 });
    }
    await mongoose.models.UsageJob.create({ name: 'bdren-usage-export', lastDay: '2026-11-09' });
    bdren.state.failures = [500, 500, 500];
    const down = await runUsageExport({ ...deps, now: NOW });
    expect(down.failed).toContain('could not take');
    const job = await mongoose.models.UsageJob.findOne({ name: 'bdren-usage-export' }).lean<{
      lastDay: string;
      lastError: string;
      lockedUntil?: Date;
    }>();
    expect(job?.lastDay).toBe('2026-11-09');
    expect(job?.lastError).toBeTruthy();
    expect(job?.lockedUntil).toBeUndefined();

    const up = await runUsageExport({ ...deps, now: new Date(NOW.getTime() + 3_600_000) });
    expect(up.failed).toBeUndefined();
    expect(up.days.map((d) => d.day)).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
    ]);
    const after = await mongoose.models.UsageJob.findOne({ name: 'bdren-usage-export' }).lean<{
      lastDay: string;
      lastError?: string;
    }>();
    expect(after?.lastDay).toBe('2026-11-13');
    expect(after?.lastError).toBeUndefined();
    expect(bdren.rows).toHaveLength(4);
  });

  it('skips a day bdren.ai refuses, still sends the others and the window reports, and keeps the error', async () => {
    const bdren = fakeBdren();
    await seed('2026-11-12', linked, { taskType: 'chat', costUsd: 0.005 });
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 0.001 });
    await seed('2026-11-14', linked, { taskType: 'chat', costUsd: 0.002 });
    await mongoose.models.UsageJob.create({ name: 'bdren-usage-export', lastDay: '2026-11-11' });
    const refusing = async (url: string, init: RequestInit): Promise<Response> =>
      JSON.parse(init.body as string).day === '2026-11-12'
        ? new Response('{}', { status: 400 })
        : bdren.fetchFn(url, init);
    const run = await runUsageExport({ config, fetchFn: refusing, sleep: noSleep, now: NOW });
    expect(run.failed).toContain('2026-11-12');
    expect(run.days.map((d) => d.day)).toEqual(['2026-11-13', '2026-11-14']);
    const job = await mongoose.models.UsageJob.findOne({ name: 'bdren-usage-export' }).lean<{
      lastDay: string;
      lastError: string;
    }>();
    expect(job?.lastDay).toBe('2026-11-13');
    expect(job?.lastError).toContain('2026-11-12');
  });

  it('skips while another server holds the lease', async () => {
    const bdren = fakeBdren();
    await mongoose.models.UsageJob.create({
      name: 'bdren-usage-export',
      lockedUntil: new Date(NOW.getTime() + 60_000),
    });
    const run = await runUsageExport({ config, fetchFn: bdren.fetchFn, sleep: noSleep, now: NOW });
    expect(run.skipped).toBe('locked');
    expect(bdren.state.calls).toBe(0);
  });
});

describe('window usage', () => {
  const month = { start: '2026-11-01T18:00:00Z', end: '2026-12-01T18:00:00Z' };
  const week = { start: '2026-11-08T18:00:00Z', end: '2026-11-15T18:00:00Z' };

  async function cache(userId: mongoose.Types.ObjectId, subject: string, issuer = ISSUER) {
    await mongoose.models.BdrenAllowance.create({
      userId,
      tenantId: '__individuals__',
      issuer,
      subject,
      etag: 'e',
      allowance: {
        product: 'synapse',
        user: { subject },
        plan_source: 'free',
        package: null,
        subscription: null,
        limits: { ai_credits: { monthly: 1_000_000, weekly: 350_000 } },
        windows: { month, week },
        etag: 'e',
      },
      fetchedAt: NOW,
      verifiedAt: NOW,
    });
  }

  it("reports what the meter counted in the member's current windows, 0 when none", async () => {
    await cache(linked, linkedSubject);
    await mongoose.models.UsageBucket.create({
      tenantId: '__individuals__',
      periodStart: new Date(month.start),
      periodEnd: new Date(month.end),
      scopeType: 'member_credits',
      scopeKey: String(linked),
      policyVersion: 1,
      usedTokens: 123_456,
    });
    const batches: MemberReport[][] = [];
    for await (const batch of windowReports(config, NOW)) {
      batches.push(batch);
    }
    expect(batches.flat()).toEqual([
      {
        issuer: ISSUER,
        zitadel_subject: linkedSubject,
        allowance: [
          { window: 'month', ...month, used: 123_456 },
          { window: 'week', ...week, used: 0 },
        ],
      },
    ]);
  });

  it('does not report an invalidated entry, whose windows may be old', async () => {
    await cache(linked, linkedSubject);
    await mongoose.models.BdrenAllowance.updateOne({ userId: linked }, { invalidatedAt: NOW });
    const reported: MemberReport[] = [];
    for await (const batch of windowReports(config, NOW)) {
      reported.push(...batch);
    }
    expect(reported).toEqual([]);
  });

  it('skips an ended window and an entry of another issuer', async () => {
    await cache(linked, linkedSubject);
    await cache(strangerIssuer, 'sub-other', 'https://elsewhere.test');
    const later = new Date('2026-11-16T00:00:00Z');
    const reported: MemberReport[] = [];
    for await (const batch of windowReports(config, later)) {
      reported.push(...batch);
    }
    expect(reported).toHaveLength(1);
    expect(reported[0].allowance?.map((w) => w.window)).toEqual(['month']);
  });

  it('is sent after the days, without touching the days rows', async () => {
    const bdren = fakeBdren();
    await seed('2026-11-13', linked, { taskType: 'chat', costUsd: 0.001 });
    await cache(linked, linkedSubject);
    const run = await runUsageExport({ config, fetchFn: bdren.fetchFn, sleep: noSleep, now: NOW });
    expect(run.windows).toBe(1);
    expect(bdren.windows.map((w) => w.window)).toEqual(['month', 'week']);
    expect(bdren.rows).toHaveLength(1);
  });
});

describe('backfillBdrenUsage', () => {
  it('counts a dry run without posting and sends a range for real', async () => {
    const bdren = fakeBdren();
    await seed('2026-11-10', linked, { taskType: 'chat', costUsd: 0.001 });
    await seed('2026-11-12', linked, { taskType: 'chat', costUsd: 0.004 });
    const deps = {
      config,
      fetchFn: bdren.fetchFn,
      sleep: noSleep,
      from: '2026-11-10',
      to: '2026-11-12',
    };
    const dry = await backfillBdrenUsage({ ...deps, dryRun: true });
    expect(dry.days.map((d) => [d.day, d.credits])).toEqual([
      ['2026-11-10', 1000],
      ['2026-11-11', 0],
      ['2026-11-12', 4000],
    ]);
    expect(bdren.state.calls).toBe(0);
    await backfillBdrenUsage(deps);
    await backfillBdrenUsage(deps);
    expect(bdren.rows.map((r) => [r.day, r.credits])).toEqual([
      ['2026-11-10', 1000],
      ['2026-11-12', 4000],
    ]);
  });
});
