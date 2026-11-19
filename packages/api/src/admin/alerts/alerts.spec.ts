import express from 'express';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, runAsSystem } from '@librechat/data-schemas';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { evaluateFirecrawl, evaluateOpenRouter, evaluateSpikes } from './rules';
import { listAlerts, markSeen, syncAlerts, getAlertModel } from './store';
import { createAlertHandlers } from './handlers';
import { runAlertChecks } from './runner';

type Reply = { status: number; body: unknown };
type Routes = Record<string, Reply>;

let mongoServer: MongoMemoryServer;
let provider: Server;
let baseUrl: string;
let routes: Routes = {};
const requested: string[] = [];

const NOW = new Date('2026-11-20T06:00:00Z');
const MS_PER_DAY = 86_400_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  await getAlertModel().init();
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    requested.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    const reply = routes[req.url ?? ''] ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
  provider.close();
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  routes = {};
  requested.length = 0;
  await getAlertModel().deleteMany({});
  await mongoose.models.Transaction.deleteMany({});
});

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OPENROUTER_KEY: 'sk-or-test',
  OPENROUTER_API_URL: `${baseUrl}/or`,
  ...extra,
});

const openRouterKeyBody = (data: object) => ({
  status: 200,
  body: { data: { limit: null, limit_remaining: null, expires_at: null, ...data } },
});

const active = async () => (await listAlerts(NOW)).filter((alert) => alert.status === 'open');

describe('OpenRouter key health', () => {
  it('raises a critical alert when OpenRouter answers 401 "User not found"', async () => {
    routes['/or/key'] = { status: 401, body: { error: { message: 'User not found.', code: 401 } } };

    const summary = await runAlertChecks(env(), NOW);

    expect(summary.raised).toBe(1);
    const [alert] = await active();
    expect(alert).toMatchObject({
      key: 'openrouter_key',
      kind: 'openrouter_key',
      severity: 'critical',
    });
    expect(alert.detail).toContain('HTTP 401');
    expect(alert.detail).toContain('User not found');
    expect(requested[0]).toContain('Bearer sk-or-test');
    expect(JSON.stringify(alert)).not.toContain('sk-or-test');
  });

  it('resolves the alert once the key works again', async () => {
    routes['/or/key'] = { status: 401, body: { error: { message: 'User not found.' } } };
    await runAlertChecks(env(), NOW);
    routes['/or/key'] = openRouterKeyBody({});

    const summary = await runAlertChecks(env(), NOW);

    expect(summary.resolved).toBe(1);
    expect(await active()).toHaveLength(0);
  });

  it('leaves an open alert alone when OpenRouter cannot be reached', async () => {
    routes['/or/key'] = { status: 401, body: { error: { message: 'User not found.' } } };
    await runAlertChecks(env(), NOW);

    const summary = await runAlertChecks(env({ OPENROUTER_API_URL: 'http://127.0.0.1:1' }), NOW);

    expect(summary.resolved).toBe(0);
    expect(await active()).toHaveLength(1);
  });

  it('raises nothing for a healthy key', async () => {
    routes['/or/key'] = openRouterKeyBody({ limit: 100, limit_remaining: 90 });

    await runAlertChecks(env(), NOW);

    expect(await active()).toHaveLength(0);
  });

  it('warns when a key expires within a week and goes critical once it has', async () => {
    const soon = new Date(NOW.getTime() + 2 * MS_PER_DAY).toISOString();
    routes['/or/key'] = openRouterKeyBody({ expires_at: soon });
    await runAlertChecks(env(), NOW);
    expect(await active()).toMatchObject([{ kind: 'openrouter_expiry', severity: 'warning' }]);

    await runAlertChecks(env(), new Date(NOW.getTime() + 3 * MS_PER_DAY));
    expect(await active()).toMatchObject([{ kind: 'openrouter_expiry', severity: 'critical' }]);
  });
});

describe('OpenRouter balance', () => {
  it('raises a critical alert when the key limit is used up', async () => {
    routes['/or/key'] = openRouterKeyBody({ limit: 2, limit_remaining: 0 });
    routes['/or/credits'] = { status: 403, body: { error: { message: 'management keys only' } } };

    await runAlertChecks(env(), NOW);

    const [alert] = await active();
    expect(alert).toMatchObject({ kind: 'openrouter_balance', severity: 'critical' });
    expect(alert.title).toBe('OpenRouter credit is used up');
  });

  it('warns when less than a fifth of the key limit is left', async () => {
    routes['/or/key'] = openRouterKeyBody({ limit: 100, limit_remaining: 15 });

    await runAlertChecks(env(), NOW);

    expect(await active()).toMatchObject([{ kind: 'openrouter_balance', severity: 'warning' }]);
  });

  it('warns when the account balance covers under three days of recent spend', async () => {
    const user = new mongoose.Types.ObjectId();
    await mongoose.models.Transaction.collection.insertMany(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((daysAgo) => ({
        user,
        tenantId: 'tenant-a',
        tokenType: 'credits',
        tokenValue: -14_000_000,
        createdAt: new Date(NOW.getTime() - daysAgo * MS_PER_DAY),
      })),
    );
    routes['/or/key'] = openRouterKeyBody({});
    routes['/or/credits'] = {
      status: 200,
      body: { data: { total_credits: 100, total_usage: 97 } },
    };

    await runAlertChecks(env(), NOW);

    const [alert] = await active();
    expect(alert).toMatchObject({ kind: 'openrouter_balance', severity: 'warning' });
    expect(alert.detail).toContain('$3.00 left');
  });

  it('shows the alert again when it gets worse after being marked seen', async () => {
    routes['/or/key'] = openRouterKeyBody({ limit: 100, limit_remaining: 15 });
    await runAlertChecks(env(), NOW);
    await markSeen('admin-1');
    expect((await active())[0].seenAt).toBeTruthy();

    routes['/or/key'] = openRouterKeyBody({ limit: 100, limit_remaining: 0 });
    await runAlertChecks(env(), NOW);

    const [alert] = await active();
    expect(alert.severity).toBe('critical');
    expect(alert.seenAt).toBeNull();
  });
});

describe('Firecrawl credits', () => {
  const firecrawl = (extra: NodeJS.ProcessEnv = {}) =>
    env({ FIRECRAWL_API_KEY: 'fc-test', FIRECRAWL_API_URL: `${baseUrl}/fc`, ...extra });

  beforeEach(() => {
    routes['/or/key'] = openRouterKeyBody({});
  });

  it('warns under 20% of the plan', async () => {
    routes['/fc/v2/team/credit-usage'] = {
      status: 200,
      body: { success: true, data: { remainingCredits: 9_000, planCredits: 100_000 } },
    };

    await runAlertChecks(firecrawl(), NOW);

    expect(await active()).toMatchObject([{ kind: 'firecrawl_credits', severity: 'warning' }]);
  });

  it('uses the configured plan size when Firecrawl does not report one', async () => {
    routes['/fc/v2/team/credit-usage'] = {
      status: 200,
      body: { data: { remaining_credits: 500 } },
    };

    await runAlertChecks(firecrawl({ ALERT_FIRECRAWL_PLAN_CREDITS: '10000' }), NOW);

    expect(await active()).toMatchObject([{ kind: 'firecrawl_credits' }]);
  });

  it('stays quiet with plenty of credits and critical at zero', async () => {
    routes['/fc/v2/team/credit-usage'] = {
      status: 200,
      body: { data: { remainingCredits: 80_000, planCredits: 100_000 } },
    };
    await runAlertChecks(firecrawl(), NOW);
    expect(await active()).toHaveLength(0);

    routes['/fc/v2/team/credit-usage'] = {
      status: 200,
      body: { data: { remainingCredits: 0, planCredits: 100_000 } },
    };
    await runAlertChecks(firecrawl(), NOW);
    expect(await active()).toMatchObject([{ kind: 'firecrawl_credits', severity: 'critical' }]);
  });

  it('raises a key alert when Firecrawl answers 401', async () => {
    routes['/fc/v2/team/credit-usage'] = {
      status: 401,
      body: { error: 'Unauthorized: Invalid token' },
    };

    await runAlertChecks(firecrawl(), NOW);

    expect(await active()).toMatchObject([{ kind: 'firecrawl_key', severity: 'critical' }]);
  });

  it('does not call Firecrawl when no key is set', async () => {
    await runAlertChecks(env(), NOW);

    expect(requested.some((line) => line.includes('/fc/'))).toBe(false);
  });
});

describe('spend spikes', () => {
  const insert = async (tenantId: string, usdPerDay: Array<[number, number]>) => {
    const user = new mongoose.Types.ObjectId();
    await mongoose.models.Transaction.collection.insertMany(
      usdPerDay.map(([daysAgo, usd]) => ({
        user,
        tenantId,
        tokenType: 'credits',
        tokenValue: -Math.round(usd * 1_000_000),
        createdAt: new Date(NOW.getTime() - daysAgo * MS_PER_DAY),
      })),
    );
  };

  it('flags an institution spending over 3x its 14-day average', async () => {
    await runAsSystem(() =>
      mongoose.models.Institution.create({
        tenantId: 'tenant-a',
        name: 'Dhaka University',
        slug: 'du',
      }),
    ).catch(() => undefined);
    await insert('tenant-a', [
      ...Array.from({ length: 14 }, (_, i): [number, number] => [i + 1, 2]),
      [0, 30],
    ]);
    routes['/or/key'] = openRouterKeyBody({});

    await runAlertChecks(env(), NOW);

    const spikes = (await active()).filter((alert) => alert.kind === 'spend_spike');
    expect(spikes.map((alert) => alert.key)).toContain('spike:institution:tenant-a:2026-11-20');
    expect(spikes[0].detail).toContain('$30.00');
  });

  it('ignores a steady day, and a small day however much it grew', async () => {
    await insert('tenant-a', [
      ...Array.from({ length: 14 }, (_, i): [number, number] => [i + 1, 10]),
      [0, 12],
    ]);
    await insert('tenant-b', [[0, 3]]);
    routes['/or/key'] = openRouterKeyBody({});

    await runAlertChecks(env(), NOW);

    expect((await active()).filter((alert) => alert.kind === 'spend_spike')).toHaveLength(0);
  });

  it('flags any day above the absolute ceiling', () => {
    const outcome = evaluateSpikes(
      [{ scope: 'institution', id: 'big', day: '2026-11-20', usd: 150 }],
      '2026-11-20',
      new Map(),
    );
    expect(outcome.findings).toMatchObject([{ severity: 'critical' }]);
  });
});

describe('alert lifecycle', () => {
  it('does not duplicate an alert on repeat checks, and lists open ones first', async () => {
    routes['/or/key'] = { status: 401, body: { error: { message: 'User not found.' } } };
    await runAlertChecks(env(), NOW);
    await runAlertChecks(env(), new Date(NOW.getTime() + 15 * 60_000));

    expect(await getAlertModel().countDocuments()).toBe(1);

    routes['/or/key'] = openRouterKeyBody({});
    await runAlertChecks(env(), NOW);
    expect((await listAlerts(NOW))[0].status).toBe('resolved');
  });

  it('marks one alert, or all, as seen', async () => {
    await syncAlerts(
      [
        { key: 'a', kind: 'openrouter_key', severity: 'critical', title: 'a', detail: '' },
        { key: 'b', kind: 'firecrawl_key', severity: 'critical', title: 'b', detail: '' },
      ],
      [],
    );
    const [first] = await active();

    expect(await markSeen('admin-1', String(first._id))).toBe(1);
    expect(await markSeen('admin-1')).toBe(1);
    expect((await active()).every((alert) => alert.seenBy === 'admin-1')).toBe(true);
  });

  it('keeps the pure rules free of side effects', () => {
    expect(
      evaluateOpenRouter({
        key: { status: 'unreachable', message: 'timeout' },
        credits: { status: 'unreachable', message: 'timeout' },
        averageDailyUsd: 0,
      }),
    ).toEqual({ kinds: [], findings: [] });
    expect(evaluateFirecrawl({ status: 'unreadable', httpStatus: 404 }, null)).toEqual({
      kinds: [],
      findings: [],
    });
  });
});

describe('alert routes', () => {
  let api: Server;
  let apiUrl: string;

  beforeAll(async () => {
    const handlers = createAlertHandlers();
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: 'admin-1' };
      next();
    });
    app.get('/', handlers.list as unknown as express.RequestHandler);
    app.post('/check', handlers.check as unknown as express.RequestHandler);
    app.post('/seen', handlers.seen as unknown as express.RequestHandler);
    app.post('/:id/seen', handlers.seen as unknown as express.RequestHandler);
    api = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => api.once('listening', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    api.close();
  });

  it('lists a failing key as an unseen alert, then none unseen after marking seen', async () => {
    await syncAlerts(
      [
        {
          key: 'openrouter_key',
          kind: 'openrouter_key',
          severity: 'critical',
          title: 'x',
          detail: 'HTTP 401',
        },
      ],
      [],
    );

    const listed = await (await fetch(apiUrl)).json();
    expect(listed.unseen).toBe(1);
    expect(listed.alerts[0]).toMatchObject({ key: 'openrouter_key', status: 'open' });

    const marked = await fetch(`${apiUrl}/seen`, { method: 'POST' });
    expect(await marked.json()).toEqual({ changed: 1 });
    expect((await (await fetch(apiUrl)).json()).unseen).toBe(0);
  });

  it('rejects a malformed alert id', async () => {
    const response = await fetch(`${apiUrl}/not-an-id/seen`, { method: 'POST' });
    expect(response.status).toBe(400);
  });
});
