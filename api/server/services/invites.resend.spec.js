const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockSendEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('~/server/utils', () => {
  const actual = jest.requireActual('~/server/utils');
  return { ...actual, sendEmail: (...args) => mockSendEmail(...args) };
});
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return { ...actual, checkEmailConfig: () => true };
});

const {
  buildInviteAudienceFilter,
  countResendableInvites,
  resendPendingInvites,
  InviteAudiences,
} = require('./institutionMembers');
const { InstitutionInvite, Institution } = require('~/db/models');

const TENANT = 'tenant-alpha';
const DAY = 86_400_000;

const actor = { id: new mongoose.Types.ObjectId().toString(), email: 'admin@alpha.bd' };

/** `expiresAt` in the past means the link no longer works, whatever the row says. */
const seed = (overrides = {}) =>
  InstitutionInvite.create({
    tenantId: TENANT,
    email: `i-${Math.random().toString(36).slice(2)}@alpha.bd`,
    name: 'Invitee',
    requestedRole: 'USER',
    status: 'pending',
    tokenHash: Math.random().toString(36),
    expiresAt: new Date(Date.now() + 3 * DAY),
    lastSentAt: new Date(Date.now() - DAY),
    ...overrides,
  });

const lapsed = (overrides = {}) => seed({ expiresAt: new Date(Date.now() - DAY), ...overrides });

describe('bulk invite resend', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    mockSendEmail.mockClear();
    mockSendEmail.mockResolvedValue(undefined);
    await Promise.all([InstitutionInvite.deleteMany({}), Institution.deleteMany({})]);
    await Institution.create({ tenantId: TENANT, name: 'Alpha', timezone: 'Asia/Dhaka' });
  });

  describe('audience partition', () => {
    beforeEach(async () => {
      await Promise.all([seed(), seed(), lapsed(), lapsed(), lapsed()]);
    });

    it('counts each audience, and the halves sum to the whole', async () => {
      const counts = await countResendableInvites({ tenantId: TENANT });

      expect(counts).toEqual({ all: 5, expired: 3, pending: 2 });
      expect(counts.expired + counts.pending).toBe(counts.all);
    });

    /**
     * Asserted against the filters rather than by resending: a resend gives the
     * invitation a fresh window, which would move it between audiences mid-test.
     */
    it('never selects the same invitation for both audiences', async () => {
      const now = new Date();
      const ids = async (audience) =>
        (
          await InstitutionInvite.find({
            tenantId: TENANT,
            ...buildInviteAudienceFilter(audience, now),
          })
            .select('_id')
            .lean()
            .exec()
        ).map((row) => row._id.toString());

      const [expired, pending, all] = await Promise.all([
        ids(InviteAudiences.EXPIRED),
        ids(InviteAudiences.PENDING),
        ids(InviteAudiences.ALL),
      ]);

      expect(expired.filter((id) => pending.includes(id))).toEqual([]);
      expect([...expired, ...pending].sort()).toEqual([...all].sort());
    });

    it.each([
      ['one second past expiry', -1000, InviteAudiences.EXPIRED, InviteAudiences.PENDING],
      ['one second before expiry', 1000, InviteAudiences.PENDING, InviteAudiences.EXPIRED],
    ])('puts an invitation %s in exactly one audience', async (_label, offset, inside, outside) => {
      await InstitutionInvite.deleteMany({});
      const now = new Date();
      await seed({ email: 'edge@alpha.bd', expiresAt: new Date(now.getTime() + offset) });

      const inCount = await InstitutionInvite.countDocuments({
        tenantId: TENANT,
        ...buildInviteAudienceFilter(inside, now),
      });
      const outCount = await InstitutionInvite.countDocuments({
        tenantId: TENANT,
        ...buildInviteAudienceFilter(outside, now),
      });

      expect(inCount).toBe(1);
      expect(outCount).toBe(0);
    });

    /**
     * Resending expired invitations gives them a fresh window, moving them into
     * `pending`. Without the cooldown, an admin working through both audiences
     * would mail those people twice.
     */
    it('does not double-mail when both audiences are resent in turn', async () => {
      await resendPendingInvites({ tenantId: TENANT, audience: InviteAudiences.EXPIRED, actor });
      const second = await resendPendingInvites({
        tenantId: TENANT,
        audience: InviteAudiences.PENDING,
        actor,
      });

      expect(mockSendEmail).toHaveBeenCalledTimes(5);
      const recipients = mockSendEmail.mock.calls.map(([payload]) => payload.email);
      expect(new Set(recipients).size).toBe(5);
      expect(second.summary.skipped).toBe(3);
    });

    it('mails each recipient exactly once when resending everything', async () => {
      const { summary } = await resendPendingInvites({
        tenantId: TENANT,
        audience: InviteAudiences.ALL,
        actor,
      });

      expect(summary.total).toBe(5);
      expect(mockSendEmail).toHaveBeenCalledTimes(5);
      const recipients = mockSendEmail.mock.calls.map(([payload]) => payload.email);
      expect(new Set(recipients).size).toBe(5);
    });

    /** A row still marked PENDING but past its window has a dead link, and must
     *  be treated as expired even though the record has not caught up. */
    it('treats a lapsed-but-PENDING invitation as expired', async () => {
      await InstitutionInvite.deleteMany({});
      const invite = await lapsed({ email: 'stale@alpha.bd' });
      expect(invite.status).toBe('pending');

      const { results } = await resendPendingInvites({
        tenantId: TENANT,
        audience: InviteAudiences.EXPIRED,
        actor,
      });

      expect(results.map((row) => row.email)).toEqual(['stale@alpha.bd']);
    });
  });

  it('never resends an accepted or revoked invitation', async () => {
    await seed({ email: 'accepted@alpha.bd', status: 'accepted' });
    await seed({ email: 'revoked@alpha.bd', status: 'revoked' });
    await seed({ email: 'live@alpha.bd' });

    const { results } = await resendPendingInvites({ tenantId: TENANT, actor });

    expect(results.map((row) => row.email)).toEqual(['live@alpha.bd']);
  });

  it('rotates the token so a previously mailed link stops working', async () => {
    const before = await seed({ email: 'rotate@alpha.bd' });

    await resendPendingInvites({ tenantId: TENANT, actor });

    const after = await InstitutionInvite.findById(before._id).lean().exec();
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  describe('cooldown', () => {
    it('skips an invitation sent within the last five minutes', async () => {
      await seed({ email: 'justsent@alpha.bd', lastSentAt: new Date(Date.now() - 60_000) });
      await seed({ email: 'stale@alpha.bd', lastSentAt: new Date(Date.now() - DAY) });

      const { summary, results } = await resendPendingInvites({ tenantId: TENANT, actor });

      expect(summary).toMatchObject({ total: 2, sent: 1, skipped: 1 });
      expect(results.find((row) => row.email === 'justsent@alpha.bd').outcome).toBe(
        'skipped_cooldown',
      );
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    /** The guard that matters: a double-click must not mail everyone twice. */
    it('makes an immediate second resend a no-op', async () => {
      await Promise.all([seed(), seed(), seed()]);

      const first = await resendPendingInvites({ tenantId: TENANT, actor });
      const second = await resendPendingInvites({ tenantId: TENANT, actor });

      expect(first.summary.sent).toBe(3);
      expect(second.summary.sent).toBe(0);
      expect(second.summary.skipped).toBe(3);
      expect(mockSendEmail).toHaveBeenCalledTimes(3);
    });
  });

  describe('partial failure', () => {
    /**
     * A send failure is not lost work: `sendInstitutionInviteEmail` catches it and
     * returns the link, so the invitation is still reissued and the admin gets a
     * copyable link to deliver by hand. The batch continues either way.
     */
    it('downgrades an undeliverable recipient to a link and still sends the rest', async () => {
      await seed({ email: 'good1@alpha.bd' });
      await seed({ email: 'bad@alpha.bd' });
      await seed({ email: 'good2@alpha.bd' });
      mockSendEmail.mockImplementation(async ({ email }) => {
        if (email === 'bad@alpha.bd') {
          throw new Error('mailbox unavailable');
        }
      });

      const { summary, results } = await resendPendingInvites({ tenantId: TENANT, actor });

      expect(summary).toMatchObject({ total: 3, sent: 2, linkOnly: 1, failed: 0 });
      const bad = results.find((row) => row.email === 'bad@alpha.bd');
      expect(bad.outcome).toBe('link_only');
      expect(bad.inviteLink).toContain('/register?token=');
    });
  });

  it('refuses a batch larger than the cap rather than mailing part of it', async () => {
    await InstitutionInvite.insertMany(
      Array.from({ length: 251 }, (_, index) => ({
        tenantId: TENANT,
        email: `bulk-${index}@alpha.bd`,
        name: 'Bulk',
        requestedRole: 'USER',
        status: 'pending',
        tokenHash: `hash-${index}`,
        expiresAt: new Date(Date.now() + 3 * DAY),
        lastSentAt: new Date(Date.now() - DAY),
      })),
    );

    await expect(resendPendingInvites({ tenantId: TENANT, actor })).rejects.toThrow(
      /more than 250/,
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('never reaches another institution', async () => {
    await seed({ email: 'ours@alpha.bd' });
    await seed({ tenantId: 'tenant-beta', email: 'theirs@beta.bd' });

    const { results } = await resendPendingInvites({ tenantId: TENANT, actor });

    expect(results.map((row) => row.email)).toEqual(['ours@alpha.bd']);
  });

  it('reports an empty audience without sending anything', async () => {
    const { summary, results } = await resendPendingInvites({
      tenantId: TENANT,
      audience: InviteAudiences.EXPIRED,
      actor,
    });

    expect(summary).toEqual({ total: 0, sent: 0, linkOnly: 0, skipped: 0, failed: 0 });
    expect(results).toEqual([]);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
