const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  listInstitutionMembers,
  listPlatformInstitutionMembers,
  streamPlatformMembers,
  getInstitutionMemberDetail,
} = require('./institutionMembers');
const { InstitutionInvite, Institution } = require('~/db/models');

const TENANT = 'tenant-alpha';
const DAY_MS = 86_400_000;

/**
 * An invitation's stored status only becomes `expired` when the invitee opens a dead
 * link; one that runs out unnoticed keeps `pending`. These cover the roster reading
 * `expiresAt` so both kinds show as expired and neither shows as invited.
 */
describe('invitation expiry in member rosters', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const seedInvite = (overrides = {}) =>
    InstitutionInvite.create({
      tenantId: TENANT,
      email: `invitee-${Math.random().toString(36).slice(2)}@alpha.bd`,
      name: 'Invited Person',
      requestedRole: 'USER',
      status: 'pending',
      tokenHash: Math.random().toString(36),
      expiresAt: new Date(Date.now() + DAY_MS),
      ...overrides,
    });

  let valid;
  let lapsed;
  let marked;

  beforeEach(async () => {
    await Promise.all([InstitutionInvite.deleteMany({}), Institution.deleteMany({})]);
    await Institution.create({
      tenantId: TENANT,
      name: 'Alpha University',
      timezone: 'Asia/Dhaka',
    });
    [valid, lapsed, marked] = await Promise.all([
      seedInvite({ email: 'valid@alpha.bd', name: 'Valid Invite' }),
      seedInvite({
        email: 'lapsed@alpha.bd',
        name: 'Lapsed Invite',
        expiresAt: new Date(Date.now() - DAY_MS),
      }),
      seedInvite({
        email: 'marked@alpha.bd',
        name: 'Marked Invite',
        status: 'expired',
        expiresAt: new Date(Date.now() - 2 * DAY_MS),
      }),
    ]);
  });

  const emails = (members) => members.map((member) => member.email).sort();

  describe('listInstitutionMembers (institution admin)', () => {
    it('lists invitations that ran out unnoticed under the expired filter', async () => {
      const result = await listInstitutionMembers({ tenantId: TENANT, status: 'expired' });
      expect(emails(result.members)).toEqual(['lapsed@alpha.bd', 'marked@alpha.bd']);
      expect(result.total).toBe(2);
    });

    it('keeps lapsed invitations out of the invited filter', async () => {
      const result = await listInstitutionMembers({ tenantId: TENANT, status: 'invited' });
      expect(emails(result.members)).toEqual(['valid@alpha.bd']);
    });

    it('labels a lapsed invitation expired in the unfiltered roster', async () => {
      const result = await listInstitutionMembers({ tenantId: TENANT });
      const byEmail = new Map(result.members.map((member) => [member.email, member]));
      expect(byEmail.get('valid@alpha.bd').status).toBe('invited');
      expect(byEmail.get('lapsed@alpha.bd').status).toBe('expired');
      expect(byEmail.get('lapsed@alpha.bd').inviteStatus).toBe('pending');
      expect(byEmail.get('marked@alpha.bd').status).toBe('expired');
    });
  });

  it('shows a lapsed invitation as expired in its detail panel', async () => {
    const detail = await getInstitutionMemberDetail({
      tenantId: TENANT,
      id: lapsed._id,
      kind: 'invite',
    });
    expect(detail.status).toBe('expired');
  });

  describe('listPlatformInstitutionMembers (superadmin)', () => {
    it('filters expired and invited by date', async () => {
      const expired = await listPlatformInstitutionMembers({ tenantId: TENANT, status: 'expired' });
      const invited = await listPlatformInstitutionMembers({ tenantId: TENANT, status: 'invited' });
      expect(emails(expired.members)).toEqual(['lapsed@alpha.bd', 'marked@alpha.bd']);
      expect(expired.total).toBe(2);
      expect(emails(invited.members)).toEqual(['valid@alpha.bd']);
      expect(invited.total).toBe(1);
    });

    it('keeps the expiry clause when combined with a name search', async () => {
      const result = await listPlatformInstitutionMembers({
        tenantId: TENANT,
        status: 'expired',
        query: 'lapsed',
      });
      expect(emails(result.members)).toEqual(['lapsed@alpha.bd']);
    });

    it('applies the same rule to standalone invitations', async () => {
      await seedInvite({
        tenantId: null,
        accountScope: 'standalone',
        email: 'solo-lapsed@example.bd',
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      await seedInvite({
        tenantId: null,
        accountScope: 'standalone',
        email: 'solo-valid@example.bd',
      });

      const expired = await listPlatformInstitutionMembers({
        accountScope: 'standalone',
        status: 'expired',
      });
      const invited = await listPlatformInstitutionMembers({
        accountScope: 'standalone',
        status: 'invited',
      });
      expect(emails(expired.members)).toEqual(['solo-lapsed@example.bd']);
      expect(emails(invited.members)).toEqual(['solo-valid@example.bd']);
    });

    it('exports the same rows the expired filter shows', async () => {
      const rows = [];
      await streamPlatformMembers({ tenantId: TENANT, status: 'expired' }, (member) => {
        rows.push(member);
      });
      expect(emails(rows)).toEqual(['lapsed@alpha.bd', 'marked@alpha.bd']);
      expect(rows.every((row) => row.status === 'expired')).toBe(true);
    });
  });

  it('leaves the valid invitation untouched in storage', async () => {
    await listInstitutionMembers({ tenantId: TENANT, status: 'expired' });
    const stored = await InstitutionInvite.findById(valid._id).lean();
    const storedLapsed = await InstitutionInvite.findById(lapsed._id).lean();
    expect(stored.status).toBe('pending');
    expect(storedLapsed.status).toBe('pending');
    expect(marked.status).toBe('expired');
  });
});
