export const REDIRECT_PARAM = 'redirect_to';
export const SESSION_KEY = 'post_login_redirect_to';

/** Matches `/login` as a full path segment, with optional basename prefix (e.g. `/librechat/login/2fa`) */
const LOGIN_PATH_RE = /(?:^|\/)login(?:\/|$)/;

/** Validates that a redirect target is a safe relative path (not an absolute or protocol-relative URL) */
export function isSafeRedirect(url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return false;
  }
  const path = url.split('?')[0].split('#')[0];
  return !LOGIN_PATH_RE.test(path);
}

/**
 * Resolves the post-login redirect from URL params and sessionStorage,
 * cleans up both sources, and returns the validated target (or null).
 */
export function getPostLoginRedirect(searchParams: URLSearchParams): string | null {
  const urlRedirect = searchParams.get(REDIRECT_PARAM);
  const storedRedirect = sessionStorage.getItem(SESSION_KEY);

  const target = urlRedirect ?? storedRedirect;

  if (storedRedirect) {
    sessionStorage.removeItem(SESSION_KEY);
  }

  if (target == null || !isSafeRedirect(target)) {
    return null;
  }

  return target;
}

export function persistRedirectToSession(value: string): void {
  if (isSafeRedirect(value)) {
    sessionStorage.setItem(SESSION_KEY, value);
  }
}

const LOGGED_OUT_KEY = 'explicit_logout';

/** Remembers, for this tab, that the user signed out, so the login page does not send them straight back to SSO. */
export function markExplicitLogout(): void {
  try {
    sessionStorage.setItem(LOGGED_OUT_KEY, '1');
  } catch {
    /* storage unavailable: the login page may redirect again, which is safe */
  }
}

/** Whether the user signed out in this tab since the login page last cleared the mark. */
export function wasExplicitLogout(): boolean {
  try {
    return sessionStorage.getItem(LOGGED_OUT_KEY) != null;
  } catch {
    return false;
  }
}

/** Clears the sign-out mark, so the next visit to the login page redirects to SSO again. */
export function clearExplicitLogout(): void {
  try {
    sessionStorage.removeItem(LOGGED_OUT_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
