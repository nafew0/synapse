import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MEMBER_EXPORT_FORMAT, exportMembersForBdren } from './export';

const ISSUER = 'https://auth.bdren.test';
const LEARN_ORG = '6f1c2f1e-0000-4000-8000-000000000001';
const UGC_ORG = '6f1c2f1e-0000-4000-8000-000000000002';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;

const migrated = (
  tenantId: string,
  email: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { _id: mongoose.Types.ObjectId } => {
  const _id = new mongoose.Types.ObjectId();
  return {
    _id,
    email,
    emailVerified: true,
    name: 'Rahim Uddin Ahmed',
    provider: 'openid',
    openidId: _id.toHexString(),
    openidIssuer: `${ISSUER}/`,
    role: 'USER',
    tenantId,
    membershipStatus: 'active',
    ...extra,
  };
};

beforeEach(async () => {
  await db().collection('users').deleteMany({});
  await db().collection('institutions').deleteMany({});
  await db().collection('platformadmins').deleteMany({});
  await db()
    .collection('institutions')
    .insertMany([
      { tenantId: 'learn', name: 'LEARN', status: 'active', bdrenOrganizationId: LEARN_ORG },
      { tenantId: 'ugc-bd', name: 'UGC', status: 'active', bdrenOrganizationId: UGC_ORG },
      { tenantId: 'test01', name: 'Test 01', status: 'closed', bdrenOrganizationId: LEARN_ORG },
      { tenantId: 'legacy', name: 'Legacy', status: 'active' },
    ]);
});

describe('exportMembersForBdren', () => {
  it('lists migrated admins and members of linked institutions, admins first', async () => {
    const admin = migrated('learn', 'Admin@Learn.test', { role: 'INSTITUTION_ADMIN' });
    const member = migrated('learn', 'b@learn.test', { emailVerified: false, name: 'Solo' });
    const suspended = migrated('learn', 'a@learn.test', { membershipStatus: 'suspended' });
    const ugc = migrated('ugc-bd', 'u@ugc.test', { role: 'INSTITUTION_ADMIN' });
    await db().collection('users').insertMany([member, suspended, admin, ugc]);

    const result = await exportMembersForBdren(db(), { issuer: ISSUER });

    expect(result.format).toBe(MEMBER_EXPORT_FORMAT);
    expect(result.issuer).toBe(ISSUER);
    const learn = result.organizations.find((org) => org.tenantId === 'learn');
    expect(learn?.organizationId).toBe(LEARN_ORG);
    expect(learn?.counts).toEqual({ admins: 1, members: 2, suspended: 1 });
    expect(learn?.people.map((person) => person.email)).toEqual([
      'admin@learn.test',
      'a@learn.test',
      'b@learn.test',
    ]);
    expect(learn?.people[0]).toEqual({
      subject: String(admin._id),
      issuer: ISSUER,
      email: 'admin@learn.test',
      emailVerified: true,
      name: 'Rahim Uddin Ahmed',
      givenName: 'Rahim',
      familyName: 'Uddin Ahmed',
      role: 'admin',
      status: 'active',
    });
    expect(learn?.people[1].status).toBe('suspended');
    expect(learn?.people[2]).toMatchObject({
      emailVerified: false,
      givenName: 'Solo',
      familyName: 'Solo',
      role: 'member',
    });
    expect(result.organizations.find((org) => org.tenantId === 'ugc-bd')?.counts).toEqual({
      admins: 1,
      members: 0,
      suspended: 0,
    });
  });

  it('leaves out staff (an institution account on the superadmin email list is not staff), unmigrated, other issuers, removed members, closed and unlinked institutions', async () => {
    const staffRow = migrated('learn', 'staff-row@learn.test', { role: 'INSTITUTION_ADMIN' });
    await db()
      .collection('users')
      .insertMany([
        migrated('learn', 'root@learn.test', { role: 'ADMIN' }),
        staffRow,
        migrated('learn', 'configured@learn.test'),
        migrated('learn', 'local@learn.test', { provider: 'local', openidId: undefined }),
        migrated('learn', 'other@learn.test', { openidIssuer: 'https://elsewhere.test' }),
        migrated('learn', 'gone@learn.test', { membershipStatus: 'removed' }),
        migrated('test01', 'closed@test01.test', { role: 'INSTITUTION_ADMIN' }),
        migrated('legacy', 'legacy@legacy.test'),
        migrated('learn', 'kept@learn.test'),
      ]);
    await db()
      .collection('platformadmins')
      .insertOne({ userId: staffRow._id, email: 'staff-row@learn.test', active: true });

    const result = await exportMembersForBdren(db(), {
      issuer: `${ISSUER}/`,
      staffEmails: ['configured@learn.test'],
    });

    const learn = result.organizations.find((org) => org.tenantId === 'learn');
    expect(learn?.people.map((person) => person.email).sort()).toEqual([
      'configured@learn.test',
      'kept@learn.test',
    ]);
    expect(result.skipped.people).toEqual({
      platform_staff: 2,
      not_migrated: 1,
      other_issuer: 1,
      removed: 1,
      institution_closed: 1,
      institution_not_linked: 1,
    });
    expect(result.skipped.institutions).toEqual([
      { tenantId: 'test01', reason: 'closed', users: 1 },
      { tenantId: 'legacy', reason: 'not_linked', users: 1 },
    ]);
    expect(result.organizations.map((org) => org.tenantId)).not.toContain('test01');
  });

  it('only reads', async () => {
    const user = migrated('learn', 'm@learn.test');
    await db().collection('users').insertOne(user);
    const before = await db().collection('users').findOne({ _id: user._id });

    await exportMembersForBdren(db(), { issuer: ISSUER });

    expect(await db().collection('users').findOne({ _id: user._id })).toEqual(before);
  });
});
