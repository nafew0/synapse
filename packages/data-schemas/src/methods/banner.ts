import type { Model, Types } from 'mongoose';
import type { TBannerDisplay } from 'librechat-data-provider';
import type {
  IBanner,
  IUser,
  IBannerView,
  ActiveBanner,
  BannerFields,
  BannerViewFields,
} from '~/types';
import { getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import logger from '~/config/winston';

type BannerViewState = Pick<BannerViewFields, 'seenAt' | 'dismissedAt'>;
type BannerViewField = 'seenAt' | 'dismissedAt';

const DUPLICATE_KEY_CODE = 11000;
const VIEW_PROJECTION = { bannerId: 1, seenAt: 1, dismissedAt: 1 } as const;

/** Banners saved by the CLI carry no `tenantId`; they are global and reach every tenant. */
function tenantScope(): (string | null)[] {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    return [null];
  }
  return [tenantId, null];
}

function resolveBanner(banner: BannerFields): ActiveBanner {
  return {
    ...banner,
    type: banner.type ?? 'banner',
    category: banner.category ?? 'update',
    display: banner.display ?? (banner.persistable ? 'always' : 'until_dismissed'),
  };
}

function isHiddenFor(display: TBannerDisplay, view?: BannerViewState | null): boolean {
  if (!view || display === 'always') {
    return false;
  }
  if (view.dismissedAt) {
    return true;
  }
  return display === 'once' && view.seenAt != null;
}

export function createBannerMethods(mongoose: typeof import('mongoose')): {
  getBanner: (user?: IUser | null) => Promise<ActiveBanner | null>;
  markBannerSeen: (userId: string | Types.ObjectId, bannerId: string) => Promise<void>;
  dismissBanner: (userId: string | Types.ObjectId, bannerId: string) => Promise<void>;
} {
  const getModels = () => ({
    Banner: mongoose.models.Banner as Model<IBanner>,
    BannerView: mongoose.models.BannerView as Model<IBannerView>,
  });

  async function findViews(user?: IUser | null): Promise<BannerViewFields[]> {
    if (!user?._id) {
      return [];
    }
    const { BannerView } = getModels();
    return BannerView.find({ user: user._id }, VIEW_PROJECTION).lean<BannerViewFields[]>();
  }

  /**
   * Retrieves the active banner for this request, or `null` when there is none,
   * it is not public and the request is anonymous, or the user has already
   * seen (`once`) or dismissed it.
   */
  async function getBanner(user?: IUser | null): Promise<ActiveBanner | null> {
    try {
      const { Banner } = getModels();
      const now = new Date();
      const scope = tenantScope();
      const bannerQuery = runAsSystem(async () =>
        Banner.findOne({
          displayFrom: { $lte: now },
          $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
          tenantId: { $in: scope },
        })
          .sort({ displayFrom: -1 })
          .lean<BannerFields>(),
      );
      const [banner, views] = await Promise.all([bannerQuery, findViews(user)]);
      if (!banner || (!banner.isPublic && user == null)) {
        return null;
      }

      const resolved = resolveBanner(banner);
      const view = views.find((entry) => entry.bannerId === banner.bannerId);
      return isHiddenFor(resolved.display, view) ? null : resolved;
    } catch (error) {
      logger.error('[getBanner] Error getting banner', error);
      throw new Error('Error getting banner');
    }
  }

  /** Records the earliest time `field` happened; safe to call repeatedly or concurrently. */
  async function recordView(
    userId: string | Types.ObjectId,
    bannerId: string,
    field: BannerViewField,
  ): Promise<void> {
    const { BannerView } = getModels();
    const filter = { user: userId, bannerId };
    const update = { $min: { [field]: new Date() } };
    try {
      await BannerView.updateOne(filter, update, { upsert: true, runValidators: true });
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY_CODE) {
        throw error;
      }
      await BannerView.updateOne(filter, update);
    }
  }

  async function markBannerSeen(userId: string | Types.ObjectId, bannerId: string) {
    await recordView(userId, bannerId, 'seenAt');
  }

  async function dismissBanner(userId: string | Types.ObjectId, bannerId: string) {
    await recordView(userId, bannerId, 'dismissedAt');
  }

  return { getBanner, markBannerSeen, dismissBanner };
}

export type BannerMethods = ReturnType<typeof createBannerMethods>;
