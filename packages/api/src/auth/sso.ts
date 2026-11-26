import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TStartupConfig } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import { normalizeOpenIdIssuer } from './openid';

/**
 * SSO-only mode: the chat app is signed in to only through BDREN OpenID (ZITADEL), and users,
 * institutions and invitations come only from bdren.ai. `BDREN_SSO_ONLY` turns it on or off; left
 * unset it is on whenever `BDREN_ISSUER` and the OpenID client are configured.
 */
export type SsoOnlySettings = {
  enabled: boolean;
  /** The BDREN issuer, normalized; the only issuer accepted while SSO-only is on. */
  issuer?: string;
};

export type SsoRefusalCode = 'SSO_ONLY' | 'SSO_REQUIRED' | 'MANAGED_IN_BDREN' | 'SUPERADMIN_ONLY';

export type SsoRefusal = {
  status: number;
  code: SsoRefusalCode;
  message: string;
};

export type SsoRefusalName =
  | 'login'
  | 'registration'
  | 'passwordReset'
  | 'emailVerification'
  | 'provider'
  | 'invitation'
  | 'managed'
  | 'session'
  | 'adminLogin';

const SIGN_IN_WITH_BDREN = 'Sign in with your bdren.ai account.';

export const SsoRefusals: Readonly<Record<SsoRefusalName, SsoRefusal>> = {
  login: { status: 403, code: 'SSO_ONLY', message: SIGN_IN_WITH_BDREN },
  registration: {
    status: 403,
    code: 'SSO_ONLY',
    message: `Accounts are created in bdren.ai. ${SIGN_IN_WITH_BDREN}`,
  },
  passwordReset: {
    status: 403,
    code: 'SSO_ONLY',
    message: `Passwords are managed in bdren.ai. ${SIGN_IN_WITH_BDREN}`,
  },
  emailVerification: {
    status: 403,
    code: 'SSO_ONLY',
    message: `Email addresses are verified in bdren.ai. ${SIGN_IN_WITH_BDREN}`,
  },
  provider: {
    status: 403,
    code: 'SSO_ONLY',
    message: `Only bdren.ai sign-in is available. ${SIGN_IN_WITH_BDREN}`,
  },
  invitation: {
    status: 410,
    code: 'SSO_ONLY',
    message: `Invitations are sent from bdren.ai. ${SIGN_IN_WITH_BDREN}`,
  },
  managed: {
    status: 410,
    code: 'MANAGED_IN_BDREN',
    message: 'Institutions, institution admins and invitations are managed in bdren.ai.',
  },
  /** 401 so the client drops the session and returns to the sign-in page. */
  session: { status: 401, code: 'SSO_REQUIRED', message: SIGN_IN_WITH_BDREN },
  adminLogin: {
    status: 403,
    code: 'SUPERADMIN_ONLY',
    message: 'Only BdREN platform superadmins can sign in here.',
  },
};

const ON = new Set(['true', '1', 'yes', 'on']);
const OFF = new Set(['false', '0', 'no', 'off']);

function isOpenIdConfigured(env: NodeJS.ProcessEnv): boolean {
  return !!env.OPENID_CLIENT_ID?.trim() && !!env.OPENID_ISSUER?.trim();
}

/** Read per call, so a test or a restart with a new environment sees the change. */
export function readSsoOnly(env: NodeJS.ProcessEnv = process.env): SsoOnlySettings {
  const issuer = normalizeOpenIdIssuer(env.BDREN_ISSUER);
  const flag = (env.BDREN_SSO_ONLY ?? '').trim().toLowerCase();
  if (OFF.has(flag)) {
    return { enabled: false, issuer };
  }
  if (ON.has(flag)) {
    return { enabled: true, issuer };
  }
  return { enabled: !!issuer && isOpenIdConfigured(env), issuer };
}

export function isBdrenIssuer(issuer: string | undefined, settings: SsoOnlySettings): boolean {
  const normalized = normalizeOpenIdIssuer(issuer);
  return !!normalized && normalized === settings.issuer;
}

export type SsoIdentity = Partial<Pick<IUser, 'provider' | 'openidId' | 'openidIssuer'>>;

/** An account that signs in through the BDREN issuer. */
export function isSsoUser(
  user: SsoIdentity | null | undefined,
  settings: SsoOnlySettings,
): boolean {
  return (
    user?.provider === 'openid' && !!user.openidId && isBdrenIssuer(user.openidIssuer, settings)
  );
}

export function sendSsoRefusal(res: Response, refusal: SsoRefusal): Response {
  const { status, code, message } = refusal;
  return res.status(status).json({ message, error: message, code });
}

/** Refuses the route while SSO-only is on; nothing else (no `ALLOW_*` flag) can reopen it. */
export function refuseWhenSsoOnly(
  refusal: SsoRefusal,
  read: () => SsoOnlySettings = readSsoOnly,
): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (read().enabled) {
      sendSsoRefusal(res, refusal);
      return;
    }
    next();
  };
}

/** OAuth router paths that stay open while SSO-only is on: the OpenID login, its logout notice and error page. */
const OPENID_OAUTH_PATHS = new Set([
  '/openid',
  '/openid/callback',
  '/openid/backchannel-logout',
  '/error',
]);

/** Mounted on the `/oauth` router: every provider but OpenID is refused while SSO-only is on. */
export function refuseOtherProvidersWhenSsoOnly(
  read: () => SsoOnlySettings = readSsoOnly,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!read().enabled || OPENID_OAUTH_PATHS.has(req.path.replace(/\/+$/, ''))) {
      next();
      return;
    }
    sendSsoRefusal(res, SsoRefusals.provider);
  };
}

/**
 * API areas a session that did not come through BDREN SSO may still reach: the superadmin tool
 * (synapse-admin) signs in locally and only calls these. Everything else is the chat app.
 */
const STAFF_PREFIXES = ['/api/admin', '/api/platform', '/api/banner', '/api/auth'];

export function isStaffPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return STAFF_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Whether this authenticated request must be refused because the session did not come through SSO. */
export function needsSsoSession(
  user: SsoIdentity | null | undefined,
  url: string | undefined,
  settings: SsoOnlySettings = readSsoOnly(),
): boolean {
  return settings.enabled && !isSsoUser(user, settings) && !isStaffPath(url);
}

export type SuperadminCheck = (user: SsoIdentity) => Promise<boolean>;

/**
 * Whether a session may be started (refreshed or 2FA-completed) without SSO: always while SSO-only
 * is off; otherwise only for SSO accounts and platform superadmins.
 */
export async function mayHoldSession(
  user: SsoIdentity,
  isSuperadmin: SuperadminCheck,
  settings: SsoOnlySettings = readSsoOnly(),
): Promise<boolean> {
  if (!settings.enabled || isSsoUser(user, settings)) {
    return true;
  }
  return isSuperadmin(user);
}

export type SsoOnlyStartupFields = Pick<
  TStartupConfig,
  | 'ssoOnly'
  | 'emailLoginEnabled'
  | 'registrationEnabled'
  | 'passwordResetEnabled'
  | 'socialLoginEnabled'
  | 'socialLogins'
  | 'openidAutoRedirect'
  | 'discordLoginEnabled'
  | 'facebookLoginEnabled'
  | 'githubLoginEnabled'
  | 'googleLoginEnabled'
  | 'appleLoginEnabled'
  | 'samlLoginEnabled'
>;

/** Startup-config fields that leave only the BDREN sign-in on the login page, or `null` when off. */
export function ssoOnlyStartupFields(
  settings: SsoOnlySettings = readSsoOnly(),
): SsoOnlyStartupFields | null {
  if (!settings.enabled) {
    return null;
  }
  return {
    ssoOnly: true,
    emailLoginEnabled: false,
    registrationEnabled: false,
    passwordResetEnabled: false,
    socialLoginEnabled: true,
    socialLogins: ['openid'],
    openidAutoRedirect: true,
    discordLoginEnabled: false,
    facebookLoginEnabled: false,
    githubLoginEnabled: false,
    googleLoginEnabled: false,
    appleLoginEnabled: false,
    samlLoginEnabled: false,
  };
}
