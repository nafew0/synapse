import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ExtensionRequest } from './auth';
import { createReportHandler } from './report';

let server: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

function response() {
  const res = { statusCode: 0, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
  };
  const out = {
    status(code: number) {
      res.statusCode = code;
      return out;
    },
    json(body: unknown) {
      res.body = body;
      return out;
    },
  };
  return { res, out: out as unknown as Response };
}

const user = new mongoose.Types.ObjectId();
const report = {
  extensionVersion: '1.0.0',
  build: '2026-11-16 08:00',
  llmModel: 'openai/gpt-6-luna',
  status: 'done',
  outcome: 'partial',
  turns: 9,
  inputTokens: 90_000,
  outputTokens: 1_200,
  hosts: ['hrm.bdren.net.bd'],
  comment: 'It left the reliever empty.',
  steps: [
    { tool: 'snapshot', args: '{}', ok: true },
    { tool: 'click', args: '{"target":{"ref":"a37"}}', ok: false, code: 'TIMEOUT' },
  ],
};

describe('a run report the user sends', () => {
  it('is kept for the user and their institution, and expires', async () => {
    const handler = createReportHandler({ store: methods });
    const { res, out } = response();
    await handler(
      {
        user: { id: String(user), tenantId: 'run-test' },
        body: report,
      } as unknown as ExtensionRequest,
      out,
    );
    expect(res.statusCode).toBe(201);
    const Reports = mongoose.models.BrowserExtensionReport;
    const kept = (await Reports.findById((res.body as { id: string }).id).lean()) as {
      steps: Array<Record<string, unknown>>;
    } | null;
    expect(kept).toMatchObject({
      tenantId: 'run-test',
      outcome: 'partial',
      hosts: ['hrm.bdren.net.bd'],
    });
    expect(kept?.steps[1]).toMatchObject({ tool: 'click', ok: false, code: 'TIMEOUT' });
    await Reports.syncIndexes();
    const ttl = (await Reports.collection.indexes()).find((i) => i.expireAfterSeconds);
    expect(ttl?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('has no place for what the page showed', async () => {
    const handler = createReportHandler({ store: methods });
    const { res, out } = response();
    const withPage = { ...report, steps: [{ ...report.steps[0], result: 'Salary: 120,000' }] };
    await handler(
      { user: { id: String(user) }, body: withPage } as unknown as ExtensionRequest,
      out,
    );
    expect(res.statusCode).toBe(201);
    const kept = await mongoose.models.BrowserExtensionReport.findById(
      (res.body as { id: string }).id,
    ).lean();
    expect(JSON.stringify(kept)).not.toContain('Salary');
  });

  it('is refused when it cannot be read', async () => {
    const handler = createReportHandler({ store: methods });
    const { res, out } = response();
    await handler(
      { user: { id: String(user) }, body: { steps: 'all of them' } } as unknown as ExtensionRequest,
      out,
    );
    expect(res.statusCode).toBe(400);
  });
});
