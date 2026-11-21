import { createHash, randomBytes, randomUUID } from 'crypto';
import type { IToken, TokenQuery, TokenCreateData, TokenUpdateData } from '@librechat/data-schemas';
import type { PhoneUploadSession } from 'librechat-data-provider';
import type { PhoneUploadOwner, PhoneUploadStore } from './store';

export const PHONE_UPLOAD_TOKEN_TYPE = 'phone_upload';
/** How long a QR code accepts files. */
export const PHONE_UPLOAD_TTL_MS: number = 10 * 60 * 1000;
/**
 * Most files one code takes in all, kept below the per-user upload limit since the desktop
 * re-uploads each one. Collected files stay staged until the session closes so this counts them.
 */
export const PHONE_UPLOAD_MAX_FILES = 20;
/** The phone page checks in every few seconds; past this gap the desktop shows it as gone. */
export const PHONE_UPLOAD_SEEN_MS: number = 15 * 1000;
/** Files older than this were left by a session nobody closed. */
const STALE_FILE_MS = PHONE_UPLOAD_TTL_MS + 5 * 60 * 1000;

export interface PhoneUploadSessionDeps {
  store: PhoneUploadStore;
  createToken: (data: TokenCreateData) => Promise<IToken>;
  findToken: (query: TokenQuery) => Promise<IToken | null>;
  updateToken: (query: TokenQuery, data: TokenUpdateData) => Promise<IToken | null>;
  deleteTokens: (query: TokenQuery) => Promise<unknown>;
  /** Runs a lookup across tenants; the phone has no signed-in user to scope it. */
  runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

export interface PhoneUploadTarget {
  endpoint?: string;
  endpointType?: string;
}

/** A session as the phone sees it once its token checks out. */
export interface ResolvedPhoneSession extends PhoneUploadOwner, PhoneUploadTarget {
  tenantId?: string;
  expiresAt: Date;
}

export interface CreatedPhoneSession {
  sessionId: string;
  token: string;
  expiresAt: string;
}

export interface PhoneUploadSessions {
  create(userId: string, target: PhoneUploadTarget): Promise<CreatedPhoneSession>;
  /** Resolves the phone's token, or null when it is unknown or expired. */
  resolve(token: string): Promise<ResolvedPhoneSession | null>;
  /** Records that the phone page is open, so the desktop can show it as connected. */
  markSeen(session: ResolvedPhoneSession): Promise<void>;
  /** The desktop's view of its own session, or null when it is gone. */
  get(userId: string, sessionId: string): Promise<PhoneUploadSession | null>;
  close(userId: string, sessionId: string): Promise<void>;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

type PhoneMetadataKey = keyof PhoneUploadTarget | 'phoneSeenAt';

const readMetadata = (token: IToken, key: PhoneMetadataKey): string | undefined => {
  const metadata = token.metadata as Map<string, unknown> | Record<string, unknown> | undefined;
  const value = metadata instanceof Map ? metadata.get(key) : metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export function createPhoneUploadSessions(deps: PhoneUploadSessionDeps): PhoneUploadSessions {
  const now = deps.now ?? Date.now;
  const isLive = (token: IToken | null): token is IToken =>
    token != null && new Date(token.expiresAt).getTime() > now();

  const findOwn = async (userId: string, sessionId: string): Promise<IToken | null> => {
    const token = await deps.findToken({
      userId,
      type: PHONE_UPLOAD_TOKEN_TYPE,
      identifier: sessionId,
    });
    return isLive(token) ? token : null;
  };

  return {
    async create(userId, target) {
      await deps.store.sweep(new Date(now() - STALE_FILE_MS)).catch(() => 0);
      const sessionId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const metadata: Record<string, string> = {};
      if (target.endpoint) {
        metadata.endpoint = target.endpoint;
      }
      if (target.endpointType) {
        metadata.endpointType = target.endpointType;
      }
      const created = await deps.createToken({
        userId,
        type: PHONE_UPLOAD_TOKEN_TYPE,
        identifier: sessionId,
        token: hashToken(token),
        expiresIn: PHONE_UPLOAD_TTL_MS / 1000,
        metadata,
      });
      return { sessionId, token, expiresAt: new Date(created.expiresAt).toISOString() };
    },

    async resolve(token) {
      if (!token) {
        return null;
      }
      const found = await deps.runAsSystem(() =>
        deps.findToken({ token: hashToken(token), type: PHONE_UPLOAD_TOKEN_TYPE }),
      );
      if (!isLive(found) || !found.identifier) {
        return null;
      }
      return {
        sessionId: found.identifier,
        userId: found.userId.toString(),
        tenantId: found.tenantId,
        endpoint: readMetadata(found, 'endpoint'),
        endpointType: readMetadata(found, 'endpointType'),
        expiresAt: new Date(found.expiresAt),
      };
    },

    async markSeen(session) {
      const metadata: Record<string, string> = { phoneSeenAt: new Date(now()).toISOString() };
      if (session.endpoint) {
        metadata.endpoint = session.endpoint;
      }
      if (session.endpointType) {
        metadata.endpointType = session.endpointType;
      }
      await deps.runAsSystem(() =>
        deps.updateToken(
          { userId: session.userId, type: PHONE_UPLOAD_TOKEN_TYPE, identifier: session.sessionId },
          { metadata },
        ),
      );
    },

    async get(userId, sessionId) {
      const token = await findOwn(userId, sessionId);
      if (!token) {
        return null;
      }
      const files = await deps.store.list({ sessionId, userId });
      const seenAt = readMetadata(token, 'phoneSeenAt');
      return {
        sessionId,
        expiresAt: new Date(token.expiresAt).toISOString(),
        maxFiles: PHONE_UPLOAD_MAX_FILES,
        phoneConnected: seenAt != null && now() - new Date(seenAt).getTime() < PHONE_UPLOAD_SEEN_MS,
        files,
      };
    },

    async close(userId, sessionId) {
      await deps.deleteTokens({ userId, type: PHONE_UPLOAD_TOKEN_TYPE, identifier: sessionId });
      await deps.store.removeSession({ sessionId, userId });
    },
  };
}
