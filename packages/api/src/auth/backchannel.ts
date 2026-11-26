import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { Algorithm, JwtHeader, JwtPayload } from 'jsonwebtoken';
import type { OpenIdEndedSession, UserMethods } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import { findOpenIDUser, normalizeOpenIdIssuer } from './openid';

/** OIDC Back-Channel Logout 1.0: the event every logout token must carry. */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const LOGOUT_TOKEN_ALGORITHMS: Algorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];
const LOGOUT_TOKEN_MAX_AGE = '30m';
const LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;

export type LogoutTokenClaims = JwtPayload & {
  iss: string;
  sub?: string;
  sid?: string;
  events: Record<string, unknown>;
};

export type SigningKeyResolver = (header: JwtHeader) => Promise<string>;

export interface LogoutTokenVerification {
  issuer: string;
  clientId: string;
  getSigningKey: SigningKeyResolver;
}

/** Claims that tie a token to an IdP sign-in session. */
export interface OpenIdSessionClaims {
  sid?: unknown;
  auth_time?: unknown;
  iat?: unknown;
}

export class LogoutTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoutTokenError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The issuer as configured and with/without its trailing slash, since IdPs differ. */
function acceptedIssuers(issuer: string): [string, ...string[]] {
  const normalized = normalizeOpenIdIssuer(issuer) ?? issuer;
  return [...new Set([issuer, normalized, `${normalized}/`])] as [string, ...string[]];
}

/** Rules from OIDC Back-Channel Logout 1.0 §2.6 that a signature check alone does not cover. */
function assertLogoutClaims(payload: JwtPayload): LogoutTokenClaims {
  const events = payload.events;
  if (!isRecord(events) || !isRecord(events[BACKCHANNEL_LOGOUT_EVENT])) {
    throw new LogoutTokenError('logout token has no back-channel logout event');
  }
  if ('nonce' in payload) {
    throw new LogoutTokenError('logout token must not contain a nonce');
  }
  if (typeof payload.iat !== 'number') {
    throw new LogoutTokenError('logout token has no iat');
  }
  if (!nonEmptyString(payload.jti)) {
    throw new LogoutTokenError('logout token has no jti');
  }
  if (!nonEmptyString(payload.sub) && !nonEmptyString(payload.sid)) {
    throw new LogoutTokenError('logout token has neither sub nor sid');
  }
  if (!nonEmptyString(payload.iss)) {
    throw new LogoutTokenError('logout token has no iss');
  }
  return payload as LogoutTokenClaims;
}

/** Verifies a back-channel logout token: signature, issuer, audience, age, then the spec's claim rules. */
export async function verifyLogoutToken(
  token: string,
  { issuer, clientId, getSigningKey }: LogoutTokenVerification,
): Promise<LogoutTokenClaims> {
  const payload = await new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      (header, callback) => {
        getSigningKey(header).then(
          (key) => callback(null, key),
          (err: Error) => callback(err),
        );
      },
      {
        algorithms: LOGOUT_TOKEN_ALGORITHMS,
        issuer: acceptedIssuers(issuer),
        audience: clientId,
        maxAge: LOGOUT_TOKEN_MAX_AGE,
        clockTolerance: LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS,
      },
      (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        if (!decoded || typeof decoded === 'string') {
          reject(new LogoutTokenError('logout token payload is not a JSON object'));
          return;
        }
        resolve(decoded);
      },
    );
  });
  return assertLogoutClaims(payload);
}

/** Resolves signing keys from the IdP's JWKS, cached and refetched on an unknown `kid`. */
export function createJwksSigningKeyResolver(jwksUri: string): SigningKeyResolver {
  const client = jwksRsa({
    jwksUri,
    cache: true,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
  return async (header) => (await client.getSigningKey(header.kid)).getPublicKey();
}

const toEpochMs = (seconds: unknown): number | undefined =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined;

/**
 * Whether a token belongs to an IdP session that back-channel logout has ended: its `sid` is
 * listed, or a session-less logout came after the token's sign-in (`auth_time`, else `iat`).
 */
export function isOpenIdSessionEnded(
  ended: OpenIdEndedSession[] | null | undefined,
  claims: OpenIdSessionClaims | null | undefined,
): boolean {
  if (!ended?.length || !claims) {
    return false;
  }
  const sid = nonEmptyString(claims.sid);
  const signedInAt = toEpochMs(claims.auth_time) ?? toEpochMs(claims.iat);
  return ended.some((entry) => {
    if (entry.sid) {
      return entry.sid === sid;
    }
    return signedInAt != null && signedInAt <= new Date(entry.endedAt).getTime();
  });
}

export interface BackchannelLogoutDeps {
  /** Null while OpenID is not configured. */
  getVerification: () => LogoutTokenVerification | null;
  /** The Synapse user for an IdP subject, or null when none exists. */
  findUserId: (subject: string, issuer: string) => Promise<string | null>;
  endSession: (userId: string, ended: OpenIdEndedSession) => Promise<boolean>;
  /** Extra clean-up once the session is recorded, e.g. dropping app-issued sessions. */
  afterSessionEnded?: (userId: string) => Promise<void>;
}

function sendLogoutError(res: Response, status: number, description: string): void {
  res.status(status).json({ error: 'invalid_request', error_description: description });
}

/**
 * `POST` handler for the IdP's back-channel logout call (form field `logout_token`). Records the
 * ended session on the user so their tokens and refreshes are refused from then on.
 * Responds 200 when handled (or no such user), 400 for a bad token, 500 so the IdP retries.
 */
export function createBackchannelLogoutHandler(deps: BackchannelLogoutDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    const token = nonEmptyString((req.body as Record<string, unknown> | undefined)?.logout_token);
    if (!token) {
      sendLogoutError(res, 400, 'logout_token is required');
      return;
    }

    const verification = deps.getVerification();
    if (!verification) {
      sendLogoutError(res, 501, 'OpenID is not configured');
      return;
    }

    let claims: LogoutTokenClaims;
    try {
      claims = await verifyLogoutToken(token, verification);
    } catch (err) {
      logger.warn(`[backchannelLogout] Rejected logout token: ${(err as Error).message}`);
      sendLogoutError(res, 400, 'invalid logout_token');
      return;
    }

    if (!claims.sub) {
      logger.warn('[backchannelLogout] Logout token without sub cannot be matched to a user');
      sendLogoutError(res, 400, 'logout_token without sub is not supported');
      return;
    }

    try {
      const userId = await deps.findUserId(claims.sub, claims.iss);
      if (!userId) {
        logger.info(`[backchannelLogout] No user for subject ${claims.sub}; nothing to end`);
        res.status(200).end();
        return;
      }
      const ended: OpenIdEndedSession = claims.sid
        ? { sid: claims.sid, endedAt: new Date() }
        : { endedAt: new Date() };
      const recorded = await deps.endSession(userId, ended);
      await deps.afterSessionEnded?.(userId);
      logger.info(
        `[backchannelLogout] ${recorded ? 'Ended' : 'Already ended'} IdP session ${claims.sid ?? '(all sessions)'} for user ${userId}`,
      );
      res.status(200).end();
    } catch (err) {
      logger.error('[backchannelLogout] Failed to end the session', err);
      res.status(500).json({ error: 'server_error' });
    }
  };
}

/** The parts of an openid-client `Configuration` the logout endpoint needs. */
export interface OpenIdClientConfigLike {
  serverMetadata(): { issuer: string; jwks_uri?: string };
  clientMetadata(): { client_id: string };
}

export interface OpenIdBackchannelSources {
  /** Throws or returns null while OpenID is not set up. */
  getOpenIdConfig: () => OpenIdClientConfigLike | null;
  findUser: UserMethods['findUser'];
  endOpenIdSession: UserMethods['endOpenIdSession'];
  afterSessionEnded?: (userId: string) => Promise<void>;
}

/**
 * Builds the back-channel logout handler from the app's OpenID configuration and user methods.
 * Lookups and writes run as system: the IdP's call carries no tenant.
 */
export function createOpenIdBackchannelLogout(sources: OpenIdBackchannelSources): RequestHandler {
  const resolvers = new Map<string, SigningKeyResolver>();

  const getVerification = (): LogoutTokenVerification | null => {
    let config: OpenIdClientConfigLike | null;
    try {
      config = sources.getOpenIdConfig();
    } catch {
      return null;
    }
    const jwksUri = config?.serverMetadata().jwks_uri;
    if (!config || !jwksUri) {
      return null;
    }
    let getSigningKey = resolvers.get(jwksUri);
    if (!getSigningKey) {
      getSigningKey = createJwksSigningKeyResolver(jwksUri);
      resolvers.set(jwksUri, getSigningKey);
    }
    return {
      issuer: config.serverMetadata().issuer,
      clientId: config.clientMetadata().client_id,
      getSigningKey,
    };
  };

  return createBackchannelLogoutHandler({
    getVerification,
    findUserId: (subject, issuer) =>
      runAsSystem(async () => {
        const { user } = await findOpenIDUser({
          findUser: sources.findUser,
          openidId: subject,
          openidIssuer: issuer,
          strategyName: 'backchannelLogout',
        });
        return user?._id?.toString() ?? null;
      }),
    endSession: (userId, ended) => runAsSystem(() => sources.endOpenIdSession(userId, ended)),
    afterSessionEnded: sources.afterSessionEnded,
  });
}
