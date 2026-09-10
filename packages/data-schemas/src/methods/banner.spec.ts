import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUser, BannerFields, BannerViewFields } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { createBannerMethods } from './banner';
import { logger, createModels } from '..';

logger.silent = true;

let Banner: mongoose.Model<BannerFields>;
let BannerView: mongoose.Model<BannerViewFields>;
let methods: ReturnType<typeof createBannerMethods>;
let mongoServer: MongoMemoryServer;

const HOUR = 60 * 60 * 1000;
const asUser = (): IUser => ({ _id: new mongoose.Types.ObjectId() }) as IUser;

const createBanner = (overrides: Record<string, string | boolean | Date | null> = {}) =>
  Banner.create({
    bannerId: 'b-1',
    message: 'Gemini 3.8 Flash is here',
    displayFrom: new Date(Date.now() - HOUR),
    displayTo: null,
    ...overrides,
  });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Banner = mongoose.models.Banner;
  BannerView = mongoose.models.BannerView;
  await BannerView.syncIndexes();
  methods = createBannerMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([Banner.deleteMany({}), BannerView.deleteMany({})]);
});

describe('getBanner', () => {
  test('resolves legacy banners: persistable maps to always, category defaults to update', async () => {
    await createBanner({ persistable: true });
    const banner = await methods.getBanner(asUser());
    expect(banner).toMatchObject({
      bannerId: 'b-1',
      type: 'banner',
      display: 'always',
      category: 'update',
    });
  });

  test('legacy non-persistable banners resolve to until_dismissed', async () => {
    await createBanner();
    expect(await methods.getBanner(asUser())).toMatchObject({ display: 'until_dismissed' });
  });

  test('serves popup (floating card) banners as well as bars', async () => {
    await createBanner({ type: 'popup', display: 'once', category: 'feature' });
    expect(await methods.getBanner(asUser())).toMatchObject({ type: 'popup', category: 'feature' });
  });

  test('returns null for anonymous requests unless the banner is public', async () => {
    await createBanner();
    expect(await methods.getBanner(null)).toBeNull();

    await Banner.updateOne({ bannerId: 'b-1' }, { isPublic: true });
    expect(await methods.getBanner(null)).toMatchObject({ bannerId: 'b-1' });
  });

  test('ignores banners outside their display window', async () => {
    await createBanner({ displayTo: new Date(Date.now() - 1000) });
    await createBanner({ bannerId: 'b-2', displayFrom: new Date(Date.now() + HOUR) });
    expect(await methods.getBanner(asUser())).toBeNull();
  });

  test('once: hidden after the user has seen it, still shown to other users', async () => {
    await createBanner({ display: 'once' });
    const user = asUser();

    expect(await methods.getBanner(user)).toMatchObject({ bannerId: 'b-1' });
    await methods.markBannerSeen(user._id, 'b-1');

    expect(await methods.getBanner(user)).toBeNull();
    expect(await methods.getBanner(asUser())).toMatchObject({ bannerId: 'b-1' });
  });

  test('until_dismissed: seeing does not hide it, dismissing does', async () => {
    await createBanner({ display: 'until_dismissed' });
    const user = asUser();

    await methods.markBannerSeen(user._id, 'b-1');
    expect(await methods.getBanner(user)).toMatchObject({ bannerId: 'b-1' });

    await methods.dismissBanner(user._id, 'b-1');
    expect(await methods.getBanner(user)).toBeNull();
  });

  test('always: stays visible even after a dismiss is recorded', async () => {
    await createBanner({ display: 'always' });
    const user = asUser();
    await methods.dismissBanner(user._id, 'b-1');
    expect(await methods.getBanner(user)).toMatchObject({ bannerId: 'b-1' });
  });

  test('a new banner id is shown again to a user who saw the previous one', async () => {
    await createBanner({ display: 'once' });
    const user = asUser();
    await methods.markBannerSeen(user._id, 'b-1');

    await Banner.updateOne({ bannerId: 'b-1' }, { bannerId: 'b-2' });
    expect(await methods.getBanner(user)).toMatchObject({ bannerId: 'b-2' });
  });

  test('global banners reach users inside a tenant; other tenants’ banners do not', async () => {
    await createBanner({ display: 'once' });
    await Banner.collection.insertOne({
      bannerId: 'other-tenant',
      message: 'Only for acme',
      displayFrom: new Date(),
      type: 'banner',
      isPublic: false,
      tenantId: 'acme',
    });
    const user = asUser();

    const banner = await tenantStorage.run({ tenantId: 'bdren' }, () => methods.getBanner(user));
    expect(banner).toMatchObject({ bannerId: 'b-1' });

    await tenantStorage.run({ tenantId: 'bdren' }, () => methods.markBannerSeen(user._id, 'b-1'));
    const after = await tenantStorage.run({ tenantId: 'bdren' }, () => methods.getBanner(user));
    expect(after).toBeNull();
  });
});

describe('markBannerSeen / dismissBanner', () => {
  test('are idempotent and keep the earliest timestamps in a single document', async () => {
    const user = asUser();
    await methods.markBannerSeen(user._id, 'b-1');
    const first = await BannerView.findOne({ user: user._id }).lean<BannerViewFields>();

    await Promise.all([
      methods.markBannerSeen(user._id, 'b-1'),
      methods.markBannerSeen(user._id, 'b-1'),
      methods.dismissBanner(user._id, 'b-1'),
    ]);

    const docs = await BannerView.find({ user: user._id }).lean<BannerViewFields[]>();
    expect(docs).toHaveLength(1);
    expect(docs[0].seenAt).toEqual(first?.seenAt);
    expect(docs[0].dismissedAt).toBeInstanceOf(Date);
  });
});
