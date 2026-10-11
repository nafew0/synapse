import fs from 'fs';
import path from 'path';
import Keyv from 'keyv';
import handlebars from 'handlebars';
import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { TIssueReportEmail } from './service';
import type { ServerRequest } from '~/types/http';
import { createIssueReportHandlers } from './handlers';
import { toPublicError } from '~/errors/public';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../../../api/server/utils/emails/issueReport.handlebars',
);
const renderTemplate = handlebars.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'));

type TSentEmail = TIssueReportEmail & { throwError: boolean; html: string };

const USER_ID = 'user-1';
const REQUEST_ID = 'req-aaaa1111-bbbb';

const savedEnv = { ...process.env };

function createSender(failWith?: Error) {
  const sent: TSentEmail[] = [];
  const sendEmail = jest.fn(async (params: TIssueReportEmail & { throwError: boolean }) => {
    if (failWith) {
      throw failWith;
    }
    sent.push({ ...params, html: renderTemplate(params.payload) });
    return { messageId: 'ok' };
  });
  return { sent, sendEmail };
}

function createReqRes(body: object, user: Partial<ServerRequest['user']> | null = {}) {
  const req = {
    body,
    user:
      user === null
        ? undefined
        : {
            id: USER_ID,
            name: 'Rahim Uddin',
            email: 'rahim@du.ac.bd',
            username: 'rahim',
            role: 'USER',
            tenantId: 'tenant-du',
            ...user,
          },
  } as unknown as ServerRequest;
  const res = {
    statusCode: 0,
    body: undefined as object | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: object) {
      this.body = data;
      return this;
    },
  };
  return { req, res: res as unknown as Response & typeof res };
}

function setup(failWith?: Error) {
  const { sent, sendEmail } = createSender(failWith);
  const dedupCache = new Keyv();
  const getInstitutionName = jest.fn(async () => 'University of Dhaka');
  const { createReport } = createIssueReportHandlers({ sendEmail, getInstitutionName, dedupCache });
  return { sent, sendEmail, dedupCache, getInstitutionName, createReport };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  process.env.EMAIL_HOST = 'smtp.example.com';
  process.env.EMAIL_FROM = 'noreply@example.com';
  process.env.SUPPORT_REPORT_EMAIL = 'info@bdren.ai, ops@bdren.ai';
  process.env.DOMAIN_CLIENT = 'https://synapse.example.bd';
  delete process.env.MAILGUN_API_KEY;
  delete process.env.EMAIL_SERVICE;
});

afterAll(() => {
  process.env = savedEnv;
});

describe('createIssueReportHandlers', () => {
  it('emails support with reporter, institution, context and the cached error summary', async () => {
    toPublicError(new Error('Upstream 429 from provider'), {
      requestId: REQUEST_ID,
      userId: USER_ID,
      route: '/api/agents/chat',
      provider: 'openrouter',
      model: 'gpt-x',
    });
    const { sent, createReport, getInstitutionName } = setup();
    const { req, res } = createReqRes({
      description: 'It broke when I asked a question',
      code: 'service_busy',
      requestId: REQUEST_ID,
      page: '/c/abc',
      conversationId: 'abc',
      recentErrors: [{ code: 'unknown', requestId: 'req-missing-1' }],
      client: { userAgent: 'Firefox 140', appVersion: 'v1' },
    });

    await createReport(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({});
    expect(getInstitutionName).toHaveBeenCalledWith('tenant-du');
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email.email).toBe('info@bdren.ai, ops@bdren.ai');
    expect(email.replyTo).toBe('rahim@du.ac.bd');
    expect(email.throwError).toBe(true);
    expect(email.template).toBe('issueReport.handlebars');
    expect(email.subject).toBe(
      '[Synapse] Issue report · service_busy · University of Dhaka · reqaaaa1',
    );
    expect(email.html).toContain('Rahim Uddin');
    expect(email.html).toContain('rahim@du.ac.bd');
    expect(email.html).toContain('University of Dhaka');
    expect(email.html).toContain('It broke when I asked a question');
    expect(email.html).toContain('Upstream 429 from provider');
    expect(email.html).toContain('/api/agents/chat');
    expect(email.html).toContain('openrouter');
    expect(email.html).toContain('Firefox 140');
    expect(email.html).toContain('https://synapse.example.bd');
    expect(email.html).toContain(
      'No cached details for request_id req-missing-1 — search the server logs for it.',
    );
  });

  it('escapes user-supplied text in the email body', async () => {
    const { sent, createReport } = setup();
    const { req, res } = createReqRes({
      description: '<script>alert(1)</script>',
      lastMessage: '<img src=x onerror=alert(2)>',
    });

    await createReport(req, res);

    expect(res.statusCode).toBe(202);
    const html = sent[0].html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src&#x3D;x onerror&#x3D;alert(2)&gt;');
    expect(sent[0].subject).toBe('[Synapse] Issue report · general · University of Dhaka · no ref');
  });

  it('does not include an error summary that belongs to another user', async () => {
    const foreignRequestId = 'req-foreign-1';
    toPublicError(new Error('secret failure of someone else'), {
      requestId: foreignRequestId,
      userId: 'someone-else',
    });
    const { sent, createReport } = setup();
    const { req, res } = createReqRes({ requestId: foreignRequestId, code: 'unknown' });

    await createReport(req, res);

    expect(res.statusCode).toBe(202);
    expect(sent[0].html).not.toContain('secret failure of someone else');
    expect(sent[0].payload.summaries).toHaveLength(0);
    expect(sent[0].payload.missing).toEqual([foreignRequestId]);
  });

  it('suppresses a second report for the same request id from the same user', async () => {
    const { sent, createReport } = setup();
    const first = createReqRes({ requestId: 'req-dup-1' });
    const second = createReqRes({ requestId: 'req-dup-1', description: 'again' });

    await createReport(first.req, first.res);
    await createReport(second.req, second.res);

    expect(first.res.statusCode).toBe(202);
    expect(second.res.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('does not deduplicate reports without a request id', async () => {
    const { sent, createReport } = setup();
    const first = createReqRes({ description: 'one' });
    const second = createReqRes({ description: 'two' });

    await createReport(first.req, first.res);
    await createReport(second.req, second.res);

    expect(sent).toHaveLength(2);
  });

  it('returns 502, logs the full report and clears the dedup key when sending fails', async () => {
    const { createReport, dedupCache, sendEmail } = setup(new Error('SMTP down'));
    const { req, res } = createReqRes({ requestId: 'req-fail-1', description: 'please help' });

    await createReport(req, res);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ code: 'report_failed' }));
    expect(await dedupCache.get(`${USER_ID}:req-fail-1`)).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[reports]'),
      expect.objectContaining({
        error: 'SMTP down',
        report: expect.objectContaining({ description: 'please help' }),
      }),
    );
  });

  it('rejects an invalid body with 400', async () => {
    const { sendEmail, createReport } = setup();
    const { req, res } = createReqRes({ page: 'no-leading-slash', unexpected: true });

    await createReport(req, res);

    expect(res.statusCode).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 503 when no support address is configured', async () => {
    delete process.env.SUPPORT_REPORT_EMAIL;
    const { sendEmail, createReport } = setup();
    const { req, res } = createReqRes({ description: 'hi' });

    await createReport(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ code: 'report_failed' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 503 when email transport is not configured', async () => {
    delete process.env.EMAIL_HOST;
    const { sendEmail, createReport } = setup();
    const { req, res } = createReqRes({ description: 'hi' });

    await createReport(req, res);

    expect(res.statusCode).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('marks users without an institution', async () => {
    const { sent, createReport, getInstitutionName } = setup();
    const { req, res } = createReqRes({ description: 'hi' }, { tenantId: undefined });

    await createReport(req, res);

    expect(getInstitutionName).not.toHaveBeenCalled();
    expect(sent[0].subject).toContain('· no institution ·');
  });
});
