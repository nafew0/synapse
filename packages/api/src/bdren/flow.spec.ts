import http from 'http';
import express from 'express';
import mongoose from 'mongoose';
import { createHash, createHmac } from 'crypto';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUsageBucket, IBdrenAllowance, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { AllowanceSubject, BdrenConfig } from './types';
import { createAllowanceService } from './allowance';
import { createAllowanceClient } from './client';
import { createWebhookHandler } from './webhook';
import { readBdrenConfig } from './config';

const PRODUCT_KEY = 'bdren_prod_synapse_test';
const SECRET = 'whsec_flow';
const ISSUER = 'https://auth.bdren.test';

interface Seen {
  key: string | undefined;
  ifNoneMatch: string | undefined;
  subject: string;
}

/** An in-process stand-in for bdren.ai's allowance endpoint. */
function startBdren() {
  const answers = new Map<string, BdrenAllowancePayload>();
  const seen: Seen[] = [];
  const state = { down: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (state.down) {
        res.writeHead(503).end();
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      const key = req.headers['x-product-api-key'] as string | undefined;
      seen.push({
        key,
        ifNoneMatch: req.headers['if-none-match'] as string | undefined,
        subject: body.zitadel_subject,
      });
      if (key !== PRODUCT_KEY) {
        res.writeHead(403).end('{"error":"forbidden"}');
        return;
      }
      const answer = answers.get(body.zitadel_subject);
      if (!answer) {
        res.writeHead(404).end('{"error":"user_not_found"}');
        return;
      }
      const etag = createHash('sha1').update(JSON.stringify(answer)).digest('hex');
      if (req.headers['if-none-match'] === `"${etag}"`) {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${etag}"` });
      res.end(JSON.stringify({ ...answer, etag }));
    });
  });
  return new Promise<{
    url: string;
    answers: typeof answers;
    seen: Seen[];
    state: typeof state;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        answers,
        seen,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function answer(
  subject: string,
  over: {
    slug?: string;
    monthly: number;
    weekly: number;
    start?: string;
    plan?: 'free' | 'personal' | 'institution';
    org?: string;
  },
): BdrenAllowancePayload {
  const start = over.start ?? '2026-11-15T04:00:00Z';
  const startMs = new Date(start).getTime();
  return {
    product: 'synapse',
    user: { subject },
    plan_source: over.plan ?? 'personal',
    package: { slug: over.slug ?? 'pro', name: over.slug ?? 'Pro', version: 1 },
    institution: over.org ? { id: over.org, seats: 5, name: 'Test Uni' } : null,
    subscription: {
      id: 'sub',
      status: 'active',
      starts_at: start,
      expires_at: new Date(startMs + 30 * 86_400_000).toISOString(),
    },
    limits: { ai_credits: { monthly: over.monthly, weekly: over.weekly } },
    windows: {
      month: { start, end: new Date(startMs + 30 * 86_400_000).toISOString() },
      week: { start, end: new Date(startMs + 7 * 86_400_000).toISOString() },
    },
    renews: 'monthly',
    etag: '',
  };
}

let mongo: MongoMemoryServer;
let bdren: Awaited<ReturnType<typeof startBdren>>;
let config: BdrenConfig;
let clock = new Date('2026-11-20T10:00:00Z');
const now = () => clock;

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();
const who = (userId: string, subject: string, account = 'du'): AllowanceSubject => ({
  userId,
  account,
  issuer: ISSUER,
  subject,
});

function makeService() {
  const client = createAllowanceClient(config);
  return createAllowanceService({ config, client, now });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(
    ['BdrenAllowance', 'BdrenEvent', 'UsageBucket', 'UsageReservation', 'Institution'].map((name) =>
      mongoose.models[name].init(),
    ),
  );
  bdren = await startBdren();
  config = readBdrenConfig({
    BDREN_ALLOWANCE_ENABLED: 'true',
    BDREN_API_URL: bdren.url,
    BDREN_PRODUCT_KEY: PRODUCT_KEY,
    BDREN_ISSUER: ISSUER,
    BDREN_WEBHOOK_SECRET: SECRET,
    BDREN_ALLOWANCE_TIMEOUT_MS: '500',
  });
});

afterAll(async () => {
  await bdren.close();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  clock = new Date('2026-11-20T10:00:00Z');
  bdren.state.down = false;
  bdren.seen.length = 0;
  bdren.answers.clear();
  await Promise.all(
    ['BdrenAllowance', 'BdrenEvent', 'UsageBucket', 'UsageReservation', 'Institution'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});

describe('allowance service', () => {
  it('fetches once, then serves the cache, sending the product key', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    const service = makeService();

    const first = await service.getAllowance(who(userA, 'sub-a'));
    const second = await service.getAllowance(who(userA, 'sub-a'));

    expect(first.origin).toBe('fresh');
    expect(second.origin).toBe('cache');
    expect(second.member.month.limit).toBe(1000);
    expect(bdren.seen).toHaveLength(1);
    expect(bdren.seen[0].key).toBe(PRODUCT_KEY);
  });

  it('revalidates by ETag after the TTL and treats a 304 as still current', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    const service = makeService();
    await service.getAllowance(who(userA, 'sub-a'));

    clock = new Date(clock.getTime() + config.ttlMs + 1000);
    const again = await service.getAllowance(who(userA, 'sub-a'));

    expect(again.origin).toBe('cache');
    expect(bdren.seen).toHaveLength(2);
    expect(bdren.seen[1].ifNoneMatch).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('picks up a changed package on the next refresh', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    const service = makeService();
    await service.getAllowance(who(userA, 'sub-a'));

    bdren.answers.set('sub-a', answer('sub-a', { slug: 'plus', monthly: 4000, weekly: 1400 }));
    const refreshed = await service.refresh(who(userA, 'sub-a'));

    expect(refreshed.member.month.limit).toBe(4000);
    expect(refreshed.packageSlug).toBe('plus');
    expect((await service.getAllowance(who(userA, 'sub-a'))).member.month.limit).toBe(4000);
  });

  it("never applies one user's limits to another", async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    bdren.answers.set('sub-b', answer('sub-b', { slug: 'plus', monthly: 9000, weekly: 3000 }));
    const service = makeService();

    const a = await service.getAllowance(who(userA, 'sub-a'));
    const b = await service.getAllowance(who(userB, 'sub-b'));
    const aAgain = await service.getAllowance(who(userA, 'sub-a'));

    expect(a.member.month.limit).toBe(1000);
    expect(b.member.month.limit).toBe(9000);
    expect(aAgain.member.month.limit).toBe(1000);
    expect(await mongoose.models.BdrenAllowance.countDocuments()).toBe(2);
  });

  it('does not reuse an entry cached for the same user under another identity or account', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    bdren.answers.set('sub-x', answer('sub-x', { monthly: 7777, weekly: 2000 }));
    const service = makeService();
    await service.getAllowance(who(userA, 'sub-a', 'du'));

    const otherIdentity = await service.getAllowance(who(userA, 'sub-x', 'du'));
    expect(otherIdentity.member.month.limit).toBe(7777);

    bdren.seen.length = 0;
    await service.getAllowance(who(userA, 'sub-x', 'buet'));
    expect(bdren.seen).toHaveLength(1);
  });

  it('keeps the last answer when bdren.ai is down, up to 24 hours, then uses Free', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { slug: 'plus', monthly: 9000, weekly: 3000 }));
    const service = makeService();
    await service.getAllowance(who(userA, 'sub-a'));
    bdren.state.down = true;

    clock = new Date(clock.getTime() + 2 * 3_600_000);
    const stale = await service.getAllowance(who(userA, 'sub-a'));
    expect(stale.origin).toBe('stale');
    expect(stale.member.month.limit).toBe(9000);

    clock = new Date(clock.getTime() + 23 * 3_600_000);
    const expired = await service.getAllowance(who(userA, 'sub-a'));
    expect(expired.origin).toBe('fallback');
    expect(expired.member.month.limit).toBe(config.fallback.monthly);
    expect(expired.planSource).toBe('free');
  });

  it('uses Free, never unlimited, for a new user when bdren.ai is unreachable', async () => {
    bdren.state.down = true;
    const result = await makeService().getAllowance(who(userA, 'sub-new'));
    expect(result.origin).toBe('fallback');
    expect(Number.isFinite(result.member.month.limit)).toBe(true);
    expect(Number.isFinite(result.member.week.limit)).toBe(true);
  });

  it('falls back to Free when the answer carries no usable limit', async () => {
    const empty = answer('sub-a', { monthly: 1, weekly: 1 });
    empty.limits = {};
    bdren.answers.set('sub-a', empty);
    const result = await makeService().getAllowance(who(userA, 'sub-a'));
    expect(result.origin).toBe('fallback');
    expect(result.member.month.limit).toBe(config.fallback.monthly);
  });

  it('falls back to Free for a user bdren.ai does not know, and on a refused key', async () => {
    expect((await makeService().getAllowance(who(userA, 'ghost'))).origin).toBe('fallback');
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    const wrongKey = createAllowanceService({
      config: { ...config, productKey: 'nope' },
      client: createAllowanceClient({ ...config, productKey: 'nope' }),
      now,
    });
    expect((await wrongKey.getAllowance(who(userB, 'sub-a'))).origin).toBe('fallback');
  });

  it('ignores an answer that names a different person', async () => {
    bdren.answers.set('sub-a', answer('someone-else', { monthly: 99999, weekly: 99999 }));
    const result = await makeService().getAllowance(who(userA, 'sub-a'));
    expect(result.origin).toBe('fallback');
    expect(await mongoose.models.BdrenAllowance.countDocuments()).toBe(0);
  });

  it('does not use a cached answer once its window has ended', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    const service = makeService();
    await service.getAllowance(who(userA, 'sub-a'));
    bdren.state.down = true;
    clock = new Date('2026-12-20T00:00:00Z');
    expect((await service.getAllowance(who(userA, 'sub-a'))).origin).toBe('fallback');
  });
});

describe('webhook', () => {
  let app: http.Server;
  let hookUrl: string;
  let service: ReturnType<typeof makeService>;

  const subjects: Record<string, AllowanceSubject> = {};

  beforeEach(async () => {
    service = makeService();
    subjects['sub-a'] = who(userA, 'sub-a');
    subjects['sub-b'] = who(userB, 'sub-b');
    const handler = createWebhookHandler({
      config,
      service,
      findSubject: async (_issuer, subject) => subjects[subject] ?? null,
      now,
    });
    const server = express();
    server.post('/hook', express.raw({ type: () => true, limit: '256kb' }), handler);
    app = await new Promise<http.Server>((resolve) => {
      const listener = server.listen(0, '127.0.0.1', () => resolve(listener));
    });
    hookUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    await new Promise((done) => app.close(done));
  });

  const sign = (secret: string, timestamp: string, body: string) =>
    createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  async function deliver(
    event: Record<string, unknown>,
    opts: { secret?: string; timestamp?: number; tamper?: boolean; unsigned?: boolean } = {},
  ) {
    const body = JSON.stringify(event);
    const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!opts.unsigned) {
      headers['X-BdREN-Timestamp'] = timestamp;
      headers['X-BdREN-Signature'] = `v1=${sign(opts.secret ?? SECRET, timestamp, body)}`;
    }
    const sent = opts.tamper ? body.replace('e1', 'e2') : body;
    return fetch(hookUrl, { method: 'POST', headers, body: sent });
  }

  const entryOf = (userId: string) =>
    mongoose.models.BdrenAllowance.findOne({ userId }).lean<IBdrenAllowance>();

  it('rejects unsigned, wrongly signed, tampered and stale requests and changes nothing', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    await service.getAllowance(subjects['sub-a']);
    const event = {
      id: 'e1',
      type: 'subscription.limits_changed',
      user: { issuer: ISSUER, subject: 'sub-a' },
    };

    expect((await deliver(event, { unsigned: true })).status).toBe(401);
    expect((await deliver(event, { secret: 'wrong' })).status).toBe(401);
    expect((await deliver(event, { tamper: true })).status).toBe(401);
    expect((await deliver(event, { timestamp: Math.floor(Date.now() / 1000) - 400 })).status).toBe(
      401,
    );

    expect((await entryOf(userA))?.invalidatedAt ?? null).toBeNull();
    expect(await mongoose.models.BdrenEvent.countDocuments()).toBe(0);
  });

  it('refuses everything when no secret is configured', async () => {
    const handler = createWebhookHandler({
      config: { ...config, webhookSecrets: [] },
      service,
      findSubject: async () => null,
    });
    const server = express();
    server.post('/hook', express.raw({ type: () => true }), handler);
    const listener = await new Promise<http.Server>((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/hook`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-BdREN-Timestamp': timestamp,
        'X-BdREN-Signature': `v1=${sign('', timestamp, '{}')}`,
      },
      body: '{}',
    });
    expect(response.status).toBe(401);
    await new Promise((done) => listener.close(done));
  });

  it("marks only the named person's cached answer stale", async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    bdren.answers.set('sub-b', answer('sub-b', { monthly: 2000, weekly: 700 }));
    await service.getAllowance(subjects['sub-a']);
    await service.getAllowance(subjects['sub-b']);

    const response = await deliver({
      id: 'e1',
      type: 'subscription.limits_changed',
      user: { issuer: ISSUER, subject: 'sub-a' },
    });

    expect(response.status).toBe(204);
    expect((await entryOf(userA))?.invalidatedAt).toBeTruthy();
    expect((await entryOf(userB))?.invalidatedAt ?? null).toBeNull();
  });

  it('refreshes within seconds: the next read sees the new package', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    await service.getAllowance(subjects['sub-a']);
    bdren.answers.set('sub-a', answer('sub-a', { slug: 'plus', monthly: 4000, weekly: 1400 }));

    await deliver({
      id: 'e1',
      type: 'subscription.limits_changed',
      user: { issuer: ISSUER, subject: 'sub-a' },
    });

    const next = await service.getAllowance(subjects['sub-a']);
    expect(next.member.month.limit).toBe(4000);
    expect(next.origin).toBe('fresh');
  });

  it("an institution event marks every member's answer and no one else's", async () => {
    await mongoose.models.Institution.create({
      tenantId: 'du',
      name: 'Test Uni',
      bdrenOrganizationId: 'org-1',
    });
    bdren.answers.set(
      'sub-a',
      answer('sub-a', { plan: 'institution', org: 'org-1', monthly: 500, weekly: 100 }),
    );
    bdren.answers.set('sub-b', answer('sub-b', { monthly: 2000, weekly: 700 }));
    await service.getAllowance(subjects['sub-a']);
    await service.getAllowance(who(userB, 'sub-b', 'buet'));

    const response = await deliver({
      id: 'e1',
      type: 'subscription.expired',
      organization: { id: 'org-1', slug: 'du' },
    });

    expect(response.status).toBe(204);
    expect((await entryOf(userA))?.invalidatedAt).toBeTruthy();
    expect((await entryOf(userB))?.invalidatedAt ?? null).toBeNull();
  });

  it('is idempotent by event id: a replay of a valid request does nothing', async () => {
    bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
    await service.getAllowance(subjects['sub-a']);
    const event = {
      id: 'e1',
      type: 'subscription.limits_changed',
      user: { issuer: ISSUER, subject: 'sub-a' },
    };
    expect((await deliver(event)).status).toBe(204);
    await service.getAllowance(subjects['sub-a']);
    const fresh = await entryOf(userA);
    expect(fresh?.invalidatedAt ?? null).toBeNull();

    expect((await deliver(event)).status).toBe(204);

    expect((await entryOf(userA))?.invalidatedAt ?? null).toBeNull();
    expect(await mongoose.models.BdrenEvent.countDocuments({ eventId: 'e1' })).toBe(1);
  });

  it('rejects a body that is not an event', async () => {
    expect((await deliver({ nope: true })).status).toBe(400);
  });

  describe('upgrade carry-over', () => {
    const OLD_START = '2026-11-01T04:00:00Z';
    const UPGRADE = '2026-11-20T04:00:00Z';
    const usedBucket = (start: string, scopeKey = userA) =>
      mongoose.models.UsageBucket.findOne({
        tenantId: 'du',
        scopeType: 'member_credits',
        scopeKey,
        periodStart: new Date(start),
      }).lean<IUsageBucket>();

    async function setUpPro() {
      bdren.answers.set(
        'sub-a',
        answer('sub-a', { slug: 'pro', monthly: 300, weekly: 105, start: OLD_START }),
      );
      await service.getAllowance(subjects['sub-a']);
      await mongoose.models.UsageBucket.create([
        {
          tenantId: 'du',
          scopeType: 'member_credits',
          scopeKey: userA,
          periodStart: new Date(OLD_START),
          periodEnd: new Date('2026-12-01T04:00:00Z'),
          policyVersion: 1,
          usedTokens: 250,
          reservedTokens: 0,
        },
        {
          tenantId: 'du',
          scopeType: 'member_credits',
          scopeKey: userA,
          periodStart: new Date(new Date(OLD_START).getTime() + 1),
          periodEnd: new Date('2026-11-08T04:00:00Z'),
          policyVersion: 1,
          usedTokens: 60,
          reservedTokens: 0,
        },
      ]);
      bdren.answers.set(
        'sub-a',
        answer('sub-a', { slug: 'plus', monthly: 800, weekly: 280, start: UPGRADE }),
      );
    }

    const upgraded = (id: string) => ({
      id,
      type: 'subscription.upgraded',
      user: { issuer: ISSUER, subject: 'sub-a' },
    });

    it('opens the new windows at the upgrade instant seeded with the old usage, once', async () => {
      await setUpPro();

      expect((await deliver(upgraded('up-1'))).status).toBe(204);

      const month = await usedBucket(UPGRADE);
      expect(month?.usedTokens).toBe(250);
      const allowance = await service.getAllowance(subjects['sub-a']);
      expect(allowance.member.month.limit).toBe(800);
      expect(allowance.member.month.window.start.toISOString()).toBe('2026-11-20T04:00:00.000Z');
      expect(allowance.member.month.limit! - (month?.usedTokens ?? 0)).toBe(550);
      const weekStart = new Date(new Date(UPGRADE).getTime() + 1).toISOString();
      expect(await usedBucket(weekStart)).toBeNull();
    });

    it('does not seed twice when the webhook is delivered twice', async () => {
      await setUpPro();

      await deliver(upgraded('up-1'));
      await deliver(upgraded('up-1'));

      expect((await usedBucket(UPGRADE))?.usedTokens).toBe(250);
      expect(await mongoose.models.UsageReservation.countDocuments({ providerKey: 'bdren' })).toBe(
        1,
      );
    });

    it('does not seed again for a different event id once the carry-over was applied', async () => {
      await setUpPro();
      await deliver(upgraded('up-1'));
      await deliver(upgraded('up-2'));

      expect((await usedBucket(UPGRADE))?.usedTokens).toBe(250);
    });

    it('leaves the next window empty, and other users and non-upgrade events alone', async () => {
      await setUpPro();
      await mongoose.models.UsageBucket.create({
        tenantId: 'du',
        scopeType: 'member_credits',
        scopeKey: userB,
        periodStart: new Date(OLD_START),
        periodEnd: new Date('2026-12-01T04:00:00Z'),
        policyVersion: 1,
        usedTokens: 111,
        reservedTokens: 0,
      });

      await deliver(upgraded('up-1'));

      expect(await usedBucket('2026-12-20T04:00:00Z')).toBeNull();
      expect(await usedBucket(UPGRADE, userB)).toBeNull();
      expect((await usedBucket(OLD_START, userB))?.usedTokens).toBe(111);
    });

    it('still carries the usage over when a request already refreshed the answer before the event arrived', async () => {
      await setUpPro();
      await service.refresh(subjects['sub-a']);

      await deliver(upgraded('up-early'));

      expect((await usedBucket(UPGRADE))?.usedTokens).toBe(250);
    });

    it('asks bdren.ai to redeliver when the refresh fails, and applies the carry-over then', async () => {
      await setUpPro();
      bdren.state.down = true;

      expect((await deliver(upgraded('up-retry'))).status).toBe(500);
      expect(await mongoose.models.BdrenEvent.countDocuments({ eventId: 'up-retry' })).toBe(0);

      bdren.state.down = false;
      expect((await deliver(upgraded('up-retry'))).status).toBe(204);
      expect((await usedBucket(UPGRADE))?.usedTokens).toBe(250);
    });

    it('does not carry the usage of a period that had already ended', async () => {
      await setUpPro();
      clock = new Date('2026-12-30T00:00:00Z');
      await mongoose.models.BdrenAllowance.updateOne(
        { userId: userA },
        { $set: { 'allowance.windows.month.end': '2026-11-10T00:00:00Z' } },
      );

      await deliver(upgraded('up-old'));

      expect(await usedBucket(UPGRADE)).toBeNull();
    });

    it('matches the event issuer to the stored one even with a trailing slash', async () => {
      bdren.answers.set('sub-a', answer('sub-a', { monthly: 1000, weekly: 350 }));
      await service.getAllowance(subjects['sub-a']);

      await deliver({
        id: 'slash',
        type: 'subscription.limits_changed',
        user: { issuer: `${ISSUER}/`, subject: 'sub-a' },
      });

      expect((await entryOf(userA))?.invalidatedAt).toBeTruthy();
    });

    it('seeds nothing for a renewal or limits change that keeps the same window', async () => {
      bdren.answers.set('sub-a', answer('sub-a', { monthly: 300, weekly: 105, start: OLD_START }));
      await service.getAllowance(subjects['sub-a']);
      await mongoose.models.UsageBucket.create({
        tenantId: 'du',
        scopeType: 'member_credits',
        scopeKey: userA,
        periodStart: new Date(OLD_START),
        periodEnd: new Date('2026-12-01T04:00:00Z'),
        policyVersion: 1,
        usedTokens: 250,
        reservedTokens: 0,
      });

      await deliver({ ...upgraded('lc-1'), type: 'subscription.limits_changed' });

      expect(await mongoose.models.UsageReservation.countDocuments({ providerKey: 'bdren' })).toBe(
        0,
      );
    });
  });
});
