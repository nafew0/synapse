const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/utils', () => {
  const actual = jest.requireActual('~/server/utils');
  return { ...actual, sendEmail: jest.fn().mockResolvedValue(undefined) };
});

const { createStandaloneInvite, completeInviteAcceptance } = require('./institutionMembers');
const { InstitutionInvite, UsagePackage, User } = require('~/db/models');

const actor = { id: new mongoose.Types.ObjectId().toString(), email: 'admin@synapse.test' };

const createPackage = (key, overrides = {}) =>
  UsagePackage.create({
    key,
    name: key,
    scopes: ['member'],
    price: 300,
    monthlyCredit: 300,
    ...overrides,
  });

const invite = (email, usagePackageKey) =>
  createStandaloneInvite({ email, usagePackageKey, invitedBy: actor });

describe('usage packages on invitations', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([UsagePackage, InstitutionInvite, User].map((model) => model.deleteMany({})));
  });

  it('invites an individual with no package, so the trial applies', async () => {
    const { invite: created } = await invite('solo@example.test');
    expect(created).toMatchObject({ accountScope: 'standalone', usagePackageKey: null });
  });

  it('records the chosen member package on the invitation', async () => {
    await createPackage('plus');
    const { invite: created } = await invite('plus@example.test', 'Plus');
    expect(created.usagePackageKey).toBe('plus');
  });

  it.each([
    ['a package that does not exist', 'missing', () => undefined],
    ['an archived package', 'old', () => createPackage('old', { active: false })],
    ['an institution package', 'pool', () => createPackage('pool', { scopes: ['institution'] })],
  ])('refuses %s', async (_label, key, setup) => {
    await setup();
    await expect(invite('bad@example.test', key)).rejects.toMatchObject({ statusCode: 400 });
    expect(await InstitutionInvite.countDocuments({})).toBe(0);
  });

  it('gives the person the package when they accept', async () => {
    await createPackage('plus');
    const { invite: created } = await invite('accept@example.test', 'plus');
    const user = await User.create({ email: 'accept@example.test', accountScope: 'standalone' });

    await completeInviteAcceptance({ inviteId: created._id, userId: user._id });

    const accepted = await User.findById(user._id).lean();
    expect(accepted.usagePackage).toMatchObject({ packageKey: 'plus', expiresAt: null });
    expect(String(accepted.usagePackage.assignedBy)).toBe(actor.id);
  });

  it('leaves the default in place when the package was archived after the invitation', async () => {
    await createPackage('plus');
    const { invite: created } = await invite('late@example.test', 'plus');
    await UsagePackage.updateOne({ key: 'plus' }, { $set: { active: false } });
    const user = await User.create({ email: 'late@example.test', accountScope: 'standalone' });

    await completeInviteAcceptance({ inviteId: created._id, userId: user._id });

    expect((await User.findById(user._id).lean()).usagePackage ?? null).toBeNull();
  });
});
