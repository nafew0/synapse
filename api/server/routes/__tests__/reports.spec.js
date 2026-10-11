const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { MongoMemoryServer } = require('mongodb-memory-server');

const TENANT_ID = 'tenant-du';

const attachUser = (req) => {
  const userId = req.headers['x-test-user'];
  if (userId) {
    req.user = {
      id: userId,
      _id: new mongoose.Types.ObjectId(userId),
      name: 'Rahim Uddin',
      email: 'rahim@du.ac.bd',
      username: 'rahim',
      role: 'USER',
      tenantId: TENANT_ID,
    };
  }
};

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    attachUser(req);
    if (!req.user) {
      return res.status(401).end();
    }
    next();
  },
}));

const savedEnv = { ...process.env };

describe('POST /api/reports', () => {
  let app;
  let mongoServer;
  let sentMessages;

  beforeAll(async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM = 'noreply@example.com';
    process.env.SUPPORT_REPORT_EMAIL = 'info@bdren.ai';
    delete process.env.MAILGUN_API_KEY;
    delete process.env.EMAIL_SERVICE;

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const { Institution } = require('@librechat/data-schemas').createModels(mongoose);
    await Institution.create({ tenantId: TENANT_ID, name: 'University of Dhaka' });

    const createTransport = nodemailer.createTransport.bind(nodemailer);
    jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => {
      const transport = createTransport({ jsonTransport: true });
      const sendMail = transport.sendMail.bind(transport);
      transport.sendMail = async (options) => {
        const info = await sendMail(options);
        sentMessages.push(JSON.parse(info.message));
        return info;
      };
      return transport;
    });

    app = express();
    app.use(express.json());
    app.use('/api/reports', require('../reports'));
  });

  afterAll(async () => {
    process.env = savedEnv;
    jest.restoreAllMocks();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    sentMessages = [];
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/reports').send({ description: 'hi' });
    expect(res.status).toBe(401);
  });

  it('sends the report through sendEmail with Reply-To, institution and escaped text', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post('/api/reports')
      .set('x-test-user', userId)
      .send({ description: '<script>x</script>', code: 'service_busy', requestId: 'req-route-1' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(sentMessages).toHaveLength(1);
    const [message] = sentMessages;
    expect(message.replyTo).toEqual([{ address: 'rahim@du.ac.bd', name: '' }]);
    expect(message.to).toEqual([{ address: 'info@bdren.ai', name: 'Synapse Support' }]);
    expect(message.subject).toBe(
      '[Synapse] Issue report · service_busy · University of Dhaka · reqroute',
    );
    expect(message.html).toContain('University of Dhaka');
    expect(message.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('No cached details for request_id req-route-1');
  });

  it('returns 429 service_busy on the 6th report in an hour', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/reports')
        .set('x-test-user', userId)
        .send({ description: `report ${i}` });
      statuses.push(res.status);
      if (i === 5) {
        expect(res.body).toEqual({ code: 'service_busy' });
      }
    }

    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    expect(sentMessages).toHaveLength(5);
  });
});
