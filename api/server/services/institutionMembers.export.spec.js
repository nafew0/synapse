const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  streamInstitutionMembers,
  streamPlatformMembers,
  listInstitutionMembers,
  listPlatformInstitutionMembers,
} = require('./institutionMembers');
const { User, InstitutionInvite, Institution } = require('~/db/models');

const TENANT = 'tenant-alpha';
const OTHER_TENANT = 'tenant-beta';

/** Collects the stream into an array so a test can assert on the whole roster. */
async function collect(filters = {}, options = {}) {
  const rows = [];
  const { count } = await streamInstitutionMembers(
    { tenantId: TENANT, ...filters },
    (member) => {
      rows.push(member);
    },
    options,
  );
  return { rows, count };
}

describe('streamInstitutionMembers', () => {
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
    await Promise.all([
      User.deleteMany({}),
      InstitutionInvite.deleteMany({}),
      Institution.deleteMany({}),
    ]);
    await Institution.create({
      tenantId: TENANT,
      name: 'Alpha University',
      timezone: 'Asia/Dhaka',
    });
  });

  const seedUser = (overrides = {}) =>
    User.create({
      tenantId: TENANT,
      name: 'Ada Rahman',
      email: `ada-${Math.random().toString(36).slice(2)}@alpha.bd`,
      role: 'USER',
      membershipStatus: 'active',
      ...overrides,
    });

  const seedInvite = (overrides = {}) =>
    InstitutionInvite.create({
      tenantId: TENANT,
      email: `invitee-${Math.random().toString(36).slice(2)}@alpha.bd`,
      name: 'Invited Person',
      requestedRole: 'USER',
      status: 'pending',
      tokenHash: Math.random().toString(36),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    });

  it('streams registered members and pending invitations together', async () => {
    await seedUser({ email: 'member@alpha.bd' });
    await seedInvite({ email: 'invited@alpha.bd' });

    const { rows, count } = await collect();

    expect(count).toBe(2);
    expect(rows.map((row) => row.email).sort()).toEqual(['invited@alpha.bd', 'member@alpha.bd']);
    expect(rows.find((row) => row.email === 'invited@alpha.bd').status).toBe('invited');
    expect(rows.find((row) => row.email === 'member@alpha.bd').status).toBe('active');
  });

  it('never leaks members of another institution', async () => {
    await seedUser({ email: 'ours@alpha.bd' });
    await User.create({
      tenantId: OTHER_TENANT,
      name: 'Someone Else',
      email: 'theirs@beta.bd',
      role: 'USER',
      membershipStatus: 'active',
    });
    await seedInvite({ tenantId: OTHER_TENANT, email: 'their-invite@beta.bd' });

    const { rows } = await collect();

    expect(rows.map((row) => row.email)).toEqual(['ours@alpha.bd']);
  });

  it('is unbounded — it returns every member, past any page size', async () => {
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        seedUser({ email: `bulk-${index}@alpha.bd`, name: `Member ${index}` }),
      ),
    );

    const { count } = await collect();

    expect(count).toBe(120);
  });

  describe('filters', () => {
    beforeEach(async () => {
      await seedUser({ email: 'active@alpha.bd', name: 'Active Person' });
      await seedUser({
        email: 'suspended@alpha.bd',
        name: 'Suspended Person',
        membershipStatus: 'suspended',
      });
      await seedInvite({ email: 'invited@alpha.bd', name: 'Invited Person' });
    });

    it.each([
      ['active', ['active@alpha.bd']],
      ['suspended', ['suspended@alpha.bd']],
      ['invited', ['invited@alpha.bd']],
    ])('status=%s selects only that group', async (status, expected) => {
      const { rows } = await collect({ status });
      expect(rows.map((row) => row.email)).toEqual(expected);
    });

    it('matches the search term against name and email', async () => {
      const byName = await collect({ query: 'Suspended' });
      expect(byName.rows.map((row) => row.email)).toEqual(['suspended@alpha.bd']);

      const byEmail = await collect({ query: 'invited@' });
      expect(byEmail.rows.map((row) => row.email)).toEqual(['invited@alpha.bd']);
    });

    /**
     * The governing rule of the export: a filtered file must describe exactly the
     * membership the page it was launched from describes.
     */
    it.each(['active', 'suspended', 'invited', undefined])(
      'agrees with the members list for status=%s',
      async (status) => {
        const streamed = await collect({ status });
        const listed = await listInstitutionMembers({
          tenantId: TENANT,
          limit: 100,
          offset: 0,
          status,
        });

        expect(streamed.rows.map((row) => row.email).sort()).toEqual(
          listed.members.map((member) => member.email).sort(),
        );
        expect(streamed.rows.map((row) => row.status).sort()).toEqual(
          listed.members.map((member) => member.status).sort(),
        );
      },
    );
  });

  it('stops reading once the client has disconnected', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => seedUser({ email: `x-${index}@alpha.bd` })),
    );

    let seen = 0;
    let aborted = false;
    const { count } = await streamInstitutionMembers(
      { tenantId: TENANT },
      () => {
        seen += 1;
        if (seen === 3) {
          aborted = true;
        }
      },
      { isCancelled: () => aborted },
    );

    expect(count).toBeLessThan(50);
    expect(seen).toBeLessThanOrEqual(4);
  });

  it('excludes accepted and revoked invitations', async () => {
    await seedInvite({ email: 'accepted@alpha.bd', status: 'accepted' });
    await seedInvite({ email: 'revoked@alpha.bd', status: 'revoked' });
    await seedInvite({ email: 'still-pending@alpha.bd' });

    const { rows } = await collect();

    expect(rows.map((row) => row.email)).toEqual(['still-pending@alpha.bd']);
  });
});

describe('streamPlatformMembers', () => {
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
    await Promise.all([
      User.deleteMany({}),
      InstitutionInvite.deleteMany({}),
      Institution.deleteMany({}),
    ]);
    await Institution.create([
      { tenantId: TENANT, name: 'Alpha University', timezone: 'Asia/Dhaka' },
      { tenantId: OTHER_TENANT, name: 'Beta Institute', timezone: 'UTC' },
    ]);
    await User.create([
      {
        tenantId: TENANT,
        name: 'Alpha One',
        email: 'a1@alpha.bd',
        role: 'USER',
        membershipStatus: 'active',
      },
      {
        tenantId: OTHER_TENANT,
        name: 'Beta One',
        email: 'b1@beta.bd',
        role: 'USER',
        membershipStatus: 'active',
      },
      { name: 'Lone Wolf', email: 'lone@gmail.com', role: 'USER', membershipStatus: 'active' },
    ]);
  });

  const collectPlatform = async (filters = {}) => {
    const rows = [];
    const { count } = await streamPlatformMembers(filters, (member) => rows.push(member));
    return { rows, count };
  };

  it('exports every institution at once when no tenant is named', async () => {
    const { rows } = await collectPlatform();
    expect(rows.map((row) => row.email).sort()).toEqual(['a1@alpha.bd', 'b1@beta.bd']);
  });

  it('labels each row with the institution it belongs to', async () => {
    const { rows } = await collectPlatform();
    const names = Object.fromEntries(rows.map((row) => [row.email, row.institutionName]));
    expect(names).toEqual({ 'a1@alpha.bd': 'Alpha University', 'b1@beta.bd': 'Beta Institute' });
  });

  it('narrows to one institution when a tenant is named', async () => {
    const { rows } = await collectPlatform({ tenantId: OTHER_TENANT });
    expect(rows.map((row) => row.email)).toEqual(['b1@beta.bd']);
  });

  it('reaches standalone accounts that belong to no institution', async () => {
    const { rows } = await collectPlatform({ accountScope: 'standalone' });
    expect(rows.map((row) => row.email)).toEqual(['lone@gmail.com']);
    expect(rows[0].institutionName).toBe('Others');
  });

  it('applies search across institutions', async () => {
    const { rows } = await collectPlatform({ query: 'Beta' });
    expect(rows.map((row) => row.email)).toEqual(['b1@beta.bd']);
  });

  /** The governing rule, applied to the superadmin view. */
  it.each([
    ['all institutions', {}],
    ['one institution', { tenantId: TENANT }],
    ['standalone accounts', { accountScope: 'standalone' }],
  ])('agrees with the platform members list for %s', async (_label, filters) => {
    const streamed = await collectPlatform(filters);
    const listed = await listPlatformInstitutionMembers({ ...filters, limit: 100, offset: 0 });

    expect(streamed.rows.map((row) => row.email).sort()).toEqual(
      listed.members.map((member) => member.email).sort(),
    );
  });
});
