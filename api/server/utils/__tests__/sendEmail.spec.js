const nodemailer = require('nodemailer');
const { readFileAsString } = require('@librechat/api');

jest.mock('nodemailer');
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  isEnabled: jest.fn((val) => val === 'true' || val === true),
  readFileAsString: jest.fn(),
}));

const savedEnv = { ...process.env };

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  process.env.EMAIL_HOST = 'smtp.example.com';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_FROM = 'noreply@example.com';
  process.env.APP_TITLE = 'TestApp';
  delete process.env.EMAIL_USERNAME;
  delete process.env.EMAIL_PASSWORD;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.EMAIL_SERVICE;
  delete process.env.EMAIL_ENCRYPTION;
  delete process.env.EMAIL_ENCRYPTION_HOSTNAME;
  delete process.env.EMAIL_ALLOW_SELFSIGNED;

  readFileAsString.mockResolvedValue({ content: '<p>{{name}}</p>' });
  nodemailer.createTransport.mockReturnValue({ sendMail: mockSendMail });
});

afterAll(() => {
  process.env = savedEnv;
});

/** Loads a fresh copy of sendEmail so process.env reads are re-evaluated. */
function loadSendEmail() {
  jest.resetModules();
  jest.mock('nodemailer', () => ({
    createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
  }));
  jest.mock('@librechat/data-schemas', () => ({
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.mock('@librechat/api', () => ({
    logAxiosError: jest.fn(),
    isEnabled: jest.fn((val) => val === 'true' || val === true),
    readFileAsString: jest.fn().mockResolvedValue({ content: '<p>{{name}}</p>' }),
  }));
  return require('../sendEmail');
}

const baseParams = {
  email: 'user@example.com',
  subject: 'Test',
  payload: { name: 'User' },
  template: 'test.handlebars',
};

describe('sendEmail SMTP auth assembly', () => {
  it('includes auth when both EMAIL_USERNAME and EMAIL_PASSWORD are set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toEqual({
      user: 'smtp_user',
      pass: 'smtp_pass',
    });
  });

  it('omits auth when both EMAIL_USERNAME and EMAIL_PASSWORD are absent', async () => {
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
  });

  it('omits auth and logs a warning when only EMAIL_USERNAME is set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('omits auth and logs a warning when only EMAIL_PASSWORD is set', async () => {
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('does not log a warning when both credentials are properly set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });

  it('does not log a warning when both credentials are absent', async () => {
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });
});

describe('sendEmail SMTP HELO hostname', () => {
  /** @returns {Record<string, unknown>} The options passed to nodemailer.createTransport. */
  async function transporterOptions() {
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    await sendEmail(baseParams);
    return createTransport.mock.calls[0][0];
  }

  it('uses EMAIL_HELO_HOSTNAME when set', async () => {
    process.env.EMAIL_HELO_HOSTNAME = 'mail.example.org';
    process.env.DOMAIN_CLIENT = 'https://chat.example.com';

    expect((await transporterOptions()).name).toBe('mail.example.org');
  });

  it('falls back to the DOMAIN_CLIENT hostname', async () => {
    delete process.env.EMAIL_HELO_HOSTNAME;
    process.env.DOMAIN_CLIENT = 'https://chat.example.com';

    expect((await transporterOptions()).name).toBe('chat.example.com');
  });

  it('omits the name for a non-FQDN DOMAIN_CLIENT', async () => {
    delete process.env.EMAIL_HELO_HOSTNAME;
    process.env.DOMAIN_CLIENT = 'http://localhost:3090';

    expect((await transporterOptions()).name).toBeUndefined();
  });

  it('omits the name for a bare IP DOMAIN_CLIENT', async () => {
    delete process.env.EMAIL_HELO_HOSTNAME;
    process.env.DOMAIN_CLIENT = 'http://203.96.189.213:3080';

    expect((await transporterOptions()).name).toBeUndefined();
  });

  it('omits the name when DOMAIN_CLIENT is unset or malformed', async () => {
    delete process.env.EMAIL_HELO_HOSTNAME;
    delete process.env.DOMAIN_CLIENT;
    expect((await transporterOptions()).name).toBeUndefined();

    process.env.DOMAIN_CLIENT = 'not a url';
    expect((await transporterOptions()).name).toBeUndefined();
  });
});

describe('sendEmail recipients and Reply-To', () => {
  it('sets replyTo on SMTP mail options when provided', async () => {
    const sendEmail = loadSendEmail();

    await sendEmail({ ...baseParams, replyTo: 'reporter@example.com' });

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.replyTo).toBe('reporter@example.com');
  });

  it('omits replyTo when not provided', async () => {
    const sendEmail = loadSendEmail();

    await sendEmail(baseParams);

    expect(mockSendMail.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('sends to every address in a comma-separated list', async () => {
    const sendEmail = loadSendEmail();

    await sendEmail({ ...baseParams, email: 'a@example.com, b@example.com' });

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.to).toBe('a@example.com, b@example.com');
    expect(mailOptions.envelope.to).toEqual(['a@example.com', 'b@example.com']);
  });

  it('keeps the named single-recipient address', async () => {
    const sendEmail = loadSendEmail();

    await sendEmail(baseParams);

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.to).toBe('"User" <user@example.com>');
    expect(mailOptions.envelope.to).toBe('user@example.com');
  });

  it('adds an h:Reply-To field to Mailgun requests', async () => {
    process.env.MAILGUN_API_KEY = 'key';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    const post = jest.fn().mockResolvedValue({ data: { id: 'mg-id' } });
    jest.resetModules();
    jest.doMock('axios', () => ({ post }));
    jest.doMock('@librechat/data-schemas', () => ({
      logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));
    jest.doMock('@librechat/api', () => ({
      logAxiosError: jest.fn(),
      isEnabled: jest.fn(),
      readFileAsString: jest.fn().mockResolvedValue({ content: '<p>{{name}}</p>' }),
    }));
    const sendEmail = require('../sendEmail');

    await sendEmail({ ...baseParams, replyTo: 'reporter@example.com' });

    const formData = post.mock.calls[0][1];
    const body = formData.getBuffer().toString();
    expect(body).toContain('name="h:Reply-To"');
    expect(body).toContain('reporter@example.com');
  });
});
