const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  setInstitutionRole,
  removeInstitutionMember,
  suspendInstitutionMember,
  reactivateInstitutionMember,
} = require('./institutionMembers');
const { Institution, User, Conversation, MemberMove } = require('~/db/models');

const actor = { id: new mongoose.Types.ObjectId().toString(), name: 'Admin' };

/**
 * In an institution linked to bdren.ai, removing a member keeps their account and data and makes
 * them an individual; an unlinked institution still deletes the account.
 */
describe('removing a member', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
  });

  async function memberOf(tenantId, extra = {}) {
    await Institution.collection.insertOne({
      tenantId,
      slug: tenantId,
      name: tenantId,
      status: 'active',
      stats: { activeMembers: 1 },
      ...extra,
    });
    const { insertedId } = await User.collection.insertOne({
      email: `${tenantId}@member.test`,
      username: tenantId,
      provider: 'local',
      role: 'USER',
      tenantId,
      accountScope: 'institution',
      membershipStatus: 'active',
    });
    await Conversation.collection.insertOne({
      conversationId: `c-${tenantId}`,
      user: String(insertedId),
      tenantId,
    });
    return String(insertedId);
  }

  it('turns a member of a linked institution into an individual, keeping account and chats', async () => {
    const userId = await memberOf('linked-uni', { bdrenOrganizationId: 'org-linked' });

    const result = await removeInstitutionMember({ tenantId: 'linked-uni', userId, actor });

    expect(result.membershipStatus).toBe('removed');
    const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(user).toMatchObject({ accountScope: 'standalone' });
    expect(user.tenantId).toBeUndefined();
    const convo = await Conversation.collection.findOne({ user: userId });
    expect(convo.tenantId).toBeUndefined();
    const institution = await Institution.collection.findOne({ tenantId: 'linked-uni' });
    expect(institution.stats.activeMembers).toBe(0);
  });

  it('still deletes the account in an institution that is not linked', async () => {
    const userId = await memberOf('legacy-uni');

    await removeInstitutionMember({ tenantId: 'legacy-uni', userId, actor });

    expect(await User.collection.countDocuments({ _id: new mongoose.Types.ObjectId(userId) })).toBe(
      0,
    );
    expect(await Conversation.collection.countDocuments({ user: userId })).toBe(0);
  });

  it('refuses suspension, reactivation and role changes while the member is moving', async () => {
    const userId = await memberOf('moving-uni', { bdrenOrganizationId: 'org-moving' });
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { movingUntil: new Date(Date.now() + 60_000) } },
    );
    const args = { tenantId: 'moving-uni', userId, actor };

    await expect(suspendInstitutionMember(args)).rejects.toMatchObject({ statusCode: 409 });
    await expect(reactivateInstitutionMember(args)).rejects.toMatchObject({ statusCode: 409 });
    await expect(setInstitutionRole({ ...args, role: 'USER' })).rejects.toMatchObject({
      statusCode: 409,
    });

    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $unset: { movingUntil: '' } },
    );
    await MemberMove.collection.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      status: 'running',
      from: 'moving-uni',
      to: null,
      reason: 'test',
    });
    await expect(suspendInstitutionMember(args)).rejects.toMatchObject({ statusCode: 409 });
  });
});
