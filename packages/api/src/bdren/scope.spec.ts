import mongoose from 'mongoose';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUser } from '@librechat/data-schemas';
import { ensureStandaloneScope, isPlatformStaff, needsStandaloneScope } from './scope';
import { quotaAccountFor } from '~/usage/accounts';

let mongo: MongoMemoryServer;
const User = () => mongoose.models.User;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(['User', 'PlatformAdmin'].map((name) => mongoose.models[name].init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  delete process.env.PLATFORM_SUPERADMIN_EMAILS;
  await Promise.all(
    ['User', 'PlatformAdmin'].map((name) => mongoose.models[name].collection.deleteMany({})),
  );
});

let seq = 0;
async function makeUser(over: Record<string, unknown> = {}): Promise<IUser> {
  seq += 1;
  const doc = await User().create({
    provider: 'openid',
    email: `u${seq}@x.test`,
    username: `u${seq}`,
    openidId: `sub-${seq}`,
    ...over,
  });
  return doc.toObject();
}

const scopeOf = async (user: IUser) =>
  (await User().findById(user._id).lean<IUser>())?.accountScope;

describe('ensureStandaloneScope', () => {
  it('makes a tenantless individual standalone, so the meter counts them', async () => {
    const user = await makeUser();
    expect(quotaAccountFor(user)).toBeNull();

    expect(await ensureStandaloneScope(user)).toBe(true);

    const saved = await User().findById(user._id).lean<IUser>();
    expect(saved?.accountScope).toBe('standalone');
    expect(quotaAccountFor(saved)).toBe('__individuals__');
    expect(await ensureStandaloneScope({ ...user, accountScope: undefined })).toBe(true);
  });

  it('never marks platform staff: a platform role, a PlatformAdmin row, or a configured email', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const byId = await makeUser();
    const byEmail = await makeUser({ email: 'boss@x.test' });
    const configured = await makeUser({ email: 'root@x.test' });
    await mongoose.models.PlatformAdmin.create([
      { userId: byId._id, email: 'by-id@x.test', active: true },
      { email: 'boss@x.test', active: true },
    ]);
    process.env.PLATFORM_SUPERADMIN_EMAILS = 'other@x.test, ROOT@x.test';

    for (const user of [admin, byId, byEmail, configured]) {
      expect(await ensureStandaloneScope(user)).toBe(false);
      expect(await scopeOf(user)).toBeUndefined();
    }
  });

  it('leaves members and users that already have a scope alone', async () => {
    const member = await makeUser({ tenantId: 'uni', accountScope: 'institution' });
    const tenantOnly = await makeUser({ tenantId: 'uni' });
    expect(await ensureStandaloneScope(member)).toBe(false);
    expect(await ensureStandaloneScope(tenantOnly)).toBe(false);
    expect(await scopeOf(tenantOnly)).toBeUndefined();
  });

  it('does not write when the stored user was placed meanwhile', async () => {
    const user = await makeUser();
    await User().collection.updateOne({ _id: user._id }, { $set: { tenantId: 'uni' } });
    expect(await ensureStandaloneScope(user)).toBe(false);
    expect(await scopeOf(user)).toBeUndefined();
  });
});

describe('isPlatformStaff', () => {
  it('judges a user not created yet by email alone', async () => {
    process.env.PLATFORM_SUPERADMIN_EMAILS = 'root@x.test';
    expect(await isPlatformStaff(undefined, undefined, 'Root@x.test')).toBe(true);
    expect(await needsStandaloneScope({ email: 'root@x.test' })).toBe(false);
    expect(await needsStandaloneScope({ email: 'someone@x.test' })).toBe(true);
    expect(await isPlatformStaff(undefined, undefined, undefined)).toBe(false);
  });
});
