import mongoose from 'mongoose';
import { createServer } from 'http';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import type { ITransaction } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { FirecrawlConfig } from '~/tools/firecrawl/client';
import {
  recordOcrCharge,
  recordServiceCharge,
  resolveServicePricing,
  firecrawlSearchCredits,
  firecrawlScrapeCredits,
} from './charges';
import { audioSeconds, getVoiceCharge, recordVoiceCharge } from './voice';
import { matchModelName, findMatchingPattern } from '~/utils';
import { createFirecrawlTool } from '~/tools/firecrawl/tool';
import { recordCollectedUsage } from '~/agents/usage';
import { recordEmbeddingCharge } from './embeddings';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const PRICE_PER_CREDIT = 0.0038;

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<ITransaction>;

const rowsFor = (user: mongoose.Types.ObjectId | string) =>
  Transaction.find({ user }).sort({ createdAt: 1 }).lean();

const newUser = (): string => new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  Transaction = mongoose.models.Transaction;
  await Transaction.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('recordServiceCharge', () => {
  const charge = (user: string) => ({
    service: 'stt' as const,
    usageKind: 'voice',
    usageUnit: 'seconds' as const,
    units: 30,
    unitPriceUsd: 0.1 / 3600,
    user,
    tenantId: TENANT,
    requestKey: `stt:a:${user}`,
  });

  it('writes one credits row with the cost fixed from the price passed in', async () => {
    const user = newUser();
    const result = await recordServiceCharge(charge(user));
    const [row] = await rowsFor(user);

    expect(result.recorded).toBe(true);
    expect(row).toMatchObject({
      tenantId: TENANT,
      tokenType: 'credits',
      service: 'stt',
      billable: true,
      usageKind: 'voice',
      usageUnit: 'seconds',
      rawAmount: 30,
      providerKey: 'stt',
    });
    expect(row.costUsd).toBeCloseTo(30 * (0.1 / 3600), 8);
    expect(row.tokenValue).toBe(-Math.round(30 * (0.1 / 3600) * 1_000_000));
  });

  it('records a replay once and a second call under another key as its own row', async () => {
    const user = newUser();
    await recordServiceCharge(charge(user));
    const replay = await recordServiceCharge(charge(user));
    expect(replay.recorded).toBe(false);
    expect(await Transaction.countDocuments({ user })).toBe(1);
    await recordServiceCharge({ ...charge(user), requestKey: `stt:b:${user}` });
    expect(await Transaction.countDocuments({ user })).toBe(2);
  });

  it('writes nothing for zero or invalid units', async () => {
    const user = newUser();
    await recordServiceCharge({ ...charge(user), units: 0 });
    await recordServiceCharge({ ...charge(user), units: Number.NaN });
    expect(await Transaction.countDocuments({ user })).toBe(0);
  });

  it('applies the schema defaults to a partial servicePricing block', () => {
    expect(resolveServicePricing().firecrawl.pricePerCreditUsd).toBe(0.0038);
    expect(resolveServicePricing({ stt: { pricePerSecondUsd: 0.01 } }).stt.pricePerSecondUsd).toBe(
      0.01,
    );
  });
});

describe('Firecrawl credits', () => {
  it('follows the plan: 2 per 10 results asked for, 1 per scrape plus 1 per PDF page', () => {
    expect([1, 10, 11, 25].map(firecrawlSearchCredits)).toEqual([2, 2, 4, 6]);
    expect([firecrawlScrapeCredits(), firecrawlScrapeCredits(3)]).toEqual([1, 4]);
  });
});

describe('Firecrawl', () => {
  let server: Server;
  let config: FirecrawlConfig;
  let reply: object;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    config = {
      apiKey: 'fc-test',
      apiUrl: `http://127.0.0.1:${port}`,
      maxChars: 1000,
      timeoutMs: 5000,
      maxSearches: 10,
      maxScrapes: 10,
      pdfMaxPages: 5,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const ledger = (user: string, tenantId = TENANT) => ({
    user,
    tenantId,
    conversationId: 'convo-1',
    pricePerCreditUsd: PRICE_PER_CREDIT,
  });

  const run = (
    name: 'search_web' | 'read_web_page',
    user: string,
    input: object,
    toolCallId: string,
    tenantId?: string,
  ) =>
    createFirecrawlTool(name, { config, ledger: ledger(user, tenantId) }).invoke({
      id: toolCallId,
      name,
      type: 'tool_call',
      args: input,
    });

  it('records a search at 2 credits per 10 results asked for, for the right tenant', async () => {
    const user = newUser();
    reply = { success: true, data: { web: [{ url: 'https://a.example', title: 'A' }] } };
    await run('search_web', user, { query: 'bdren', limit: 10 }, 'call-1', OTHER_TENANT);

    const rows = await rowsFor(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: OTHER_TENANT,
      service: 'firecrawl',
      usageKind: 'web_search',
      billable: true,
      rawAmount: 2,
      conversationId: 'convo-1',
    });
    expect(rows[0].costUsd).toBeCloseTo(2 * PRICE_PER_CREDIT, 8);
  });

  it('records a scrape as 1 credit plus 1 per PDF page returned', async () => {
    const user = newUser();
    reply = {
      success: true,
      data: { markdown: '# Report', metadata: { url: 'https://a.example/r.pdf', numPages: 3 } },
    };
    await run('read_web_page', user, { url: 'https://a.example/r.pdf' }, 'call-2');

    const [row] = await rowsFor(user);
    expect(row).toMatchObject({ usageKind: 'web_scrape', rawAmount: 4, tenantId: TENANT });
    expect(row.costUsd).toBeCloseTo(4 * PRICE_PER_CREDIT, 8);
  });

  it('caps PDF pages at the parser limit and prefers the credits Firecrawl reports', async () => {
    const capped = newUser();
    reply = { success: true, data: { markdown: 'text', metadata: { numPages: 40 } } };
    await run('read_web_page', capped, { url: 'https://a.example/big.pdf' }, 'call-3');
    expect((await rowsFor(capped))[0].rawAmount).toBe(6);

    const reported = newUser();
    reply = { success: true, creditsUsed: 9, data: { markdown: 'text', metadata: {} } };
    await run('read_web_page', reported, { url: 'https://a.example/x' }, 'call-4');
    expect((await rowsFor(reported))[0].rawAmount).toBe(9);
  });

  it('records nothing for a call that returned no document', async () => {
    const user = newUser();
    reply = { success: true, data: { web: [] } };
    await run('search_web', user, { query: 'nothing' }, 'call-5');
    reply = { success: true, data: { markdown: '', metadata: { statusCode: 404 } } };
    await run('read_web_page', user, { url: 'https://a.example/missing' }, 'call-6');
    expect(await Transaction.countDocuments({ user })).toBe(0);
  });

  it('records a replayed tool call once', async () => {
    const user = newUser();
    reply = { success: true, data: { markdown: 'text', metadata: {} } };
    await run('read_web_page', user, { url: 'https://a.example/p' }, 'call-7');
    await run('read_web_page', user, { url: 'https://a.example/p' }, 'call-7');
    expect(await Transaction.countDocuments({ user })).toBe(1);
    await run('read_web_page', user, { url: 'https://a.example/p' }, 'call-8');
    expect(await Transaction.countDocuments({ user })).toBe(2);
  });
});

describe('voice input', () => {
  const wav = (seconds: number): Buffer => {
    const byteRate = 32_000;
    const buffer = Buffer.alloc(44 + seconds * byteRate);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(byteRate, 28);
    return buffer;
  };
  const price = 0.1 / 3600;

  it('uses the provider duration, then the WAV header, then a size estimate', () => {
    expect(
      audioSeconds({ providerSeconds: 12.5, buffer: Buffer.alloc(10), mimetype: 'audio/wav' }),
    ).toBe(12.5);
    expect(audioSeconds({ buffer: wav(10), mimetype: 'audio/wav' })).toBeCloseTo(10, 3);
    expect(audioSeconds({ buffer: Buffer.alloc(60_000), mimetype: 'audio/webm' })).toBe(10);
  });

  it('records seconds of audio at the configured price for the user and tenant', async () => {
    const user = newUser();
    await recordVoiceCharge({
      user,
      tenantId: OTHER_TENANT,
      pricePerSecondUsd: price,
      buffer: wav(20),
      mimetype: 'audio/wav',
    });
    const [row] = await rowsFor(user);
    expect(row).toMatchObject({
      tenantId: OTHER_TENANT,
      service: 'stt',
      usageKind: 'voice',
      usageUnit: 'seconds',
      billable: true,
    });
    expect(row.rawAmount).toBeCloseTo(20, 3);
    expect(row.costUsd).toBeCloseTo(20 * price, 6);
  });

  it('records a replay of the same recording once', async () => {
    const user = newUser();
    const input = {
      user,
      tenantId: TENANT,
      pricePerSecondUsd: price,
      buffer: wav(5),
      mimetype: 'audio/wav',
      now: new Date('2026-11-20T10:00:10Z'),
    };
    await recordVoiceCharge(input);
    await recordVoiceCharge({ ...input, now: new Date('2026-11-20T10:00:40Z') });
    expect(await Transaction.countDocuments({ user })).toBe(1);
    await recordVoiceCharge({ ...input, now: new Date('2026-11-20T10:05:00Z') });
    expect(await Transaction.countDocuments({ user })).toBe(2);
  });

  it('bills the signed-in user from the config price, and nobody when signed out', () => {
    expect(
      getVoiceCharge({ user: { id: 'u1', tenantId: 't1' } as never, config: undefined }),
    ).toEqual({
      user: 'u1',
      tenantId: 't1',
      pricePerSecondUsd: price,
    });
    expect(getVoiceCharge({ user: undefined, config: undefined })).toBeUndefined();
  });
});

describe('embeddings', () => {
  const base = { tenantId: TENANT, pricePer1MTokensUsd: 0.15 };

  it('records indexing as platform cost, from the provider token count when it has one', async () => {
    const user = newUser();
    await recordEmbeddingCharge({
      ...base,
      user,
      phase: 'index',
      jobId: 'file-1',
      fileId: 'file-1',
      tokens: 60_000,
      chars: 999,
    });
    const [row] = await rowsFor(user);
    expect(row).toMatchObject({
      tenantId: TENANT,
      service: 'embeddings',
      usageKind: 'embedding_index',
      usageUnit: 'tokens',
      billable: false,
      rawAmount: 60_000,
      fileId: 'file-1',
    });
    expect(row.costUsd).toBeCloseTo(0.009, 6);
  });

  it('estimates tokens as characters ÷ 4 otherwise, and records a re-indexed file once', async () => {
    const user = newUser();
    const input = { ...base, user, phase: 'index' as const, jobId: 'file-2', chars: 4_000_000 };
    await recordEmbeddingCharge(input);
    await recordEmbeddingCharge(input);
    const rows = await rowsFor(user);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawAmount).toBe(1_000_000);
    expect(rows[0].costUsd).toBeCloseTo(0.15, 6);
  });

  it('records a search under its own key', async () => {
    const user = newUser();
    await recordEmbeddingCharge({ ...base, user, phase: 'query', jobId: 'call-1', chars: 80 });
    await recordEmbeddingCharge({ ...base, user, phase: 'query', jobId: 'call-2', chars: 80 });
    expect(await Transaction.countDocuments({ user, usageKind: 'embedding_query' })).toBe(2);
  });
});

describe('upload-time OCR', () => {
  const input = (user: string) => ({
    user,
    tenantId: TENANT,
    fileId: 'upload-1',
    pages: 4,
    pricePerPageUsd: 0.015,
    modelKey: 'upload/mistral_ocr',
  });

  it('records pages and cost like read_document does', async () => {
    const user = newUser();
    await recordOcrCharge(input(user));
    const [row] = await rowsFor(user);
    expect(row).toMatchObject({
      tenantId: TENANT,
      tokenType: 'credits',
      service: 'unstructured',
      usageKind: 'ocr',
      billable: true,
      pages: 4,
      fileId: 'upload-1',
      tokenValue: -60_000,
    });
    expect(row.costUsd).toBeCloseTo(0.06, 8);
  });

  it('records a retried upload once', async () => {
    const user = newUser();
    await recordOcrCharge(input(user));
    await recordOcrCharge(input(user));
    expect(await Transaction.countDocuments({ user })).toBe(1);
  });
});

describe('memory agent usage', () => {
  const db = createMethods(mongoose, {
    matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
    findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
  });
  const deps = {
    /** Unused: with `pricing` and `bulkWriteOps` the recorder writes through insertMany. */
    spendTokens: async () => undefined,
    spendStructuredTokens: async () => undefined,
    pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
    bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
  };
  const usage: UsageMetadata[] = [
    { input_tokens: 1000, output_tokens: 200, model: 'google/gemini-3.8-flash' },
  ];
  const params = (user: string, context: string, billable?: boolean) => ({
    user,
    tenantId: TENANT,
    requireTenant: true,
    conversationId: 'convo-m',
    messageId: 'msg-m',
    collectedUsage: usage,
    model: 'google/gemini-3.8-flash',
    context,
    billable,
    balance: { enabled: false },
    transactions: { enabled: true },
  });

  it('records memory rows as platform cost, once per extraction', async () => {
    const user = newUser();
    await recordCollectedUsage(deps, params(user, 'memory', false));
    await recordCollectedUsage(deps, params(user, 'memory', false));

    const rows = await rowsFor(user);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tokenType).sort()).toEqual(['completion', 'prompt']);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenantId: TENANT,
        context: 'memory',
        service: 'openrouter',
        billable: false,
      });
    }
  });

  it('records chat rows as billable by default', async () => {
    const user = newUser();
    await recordCollectedUsage(deps, params(user, 'message'));
    const rows = await rowsFor(user);
    expect(rows.every((row) => row.service === 'openrouter' && row.billable === true)).toBe(true);
  });
});
