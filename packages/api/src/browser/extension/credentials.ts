import { randomBytes, randomInt } from 'crypto';
import type { Types } from 'mongoose';
import type { BrowserExtensionMethods, IBrowserExtensionCredential } from '@librechat/data-schemas';

export const CODE_TTL_MS: number = 10 * 60 * 1000;
export const TOKEN_TTL_MS: number = 30 * 24 * 60 * 60 * 1000;
/** Letters and digits that cannot be mistaken for each other when read off a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export type CredentialStore = Pick<
  BrowserExtensionMethods,
  | 'createBrowserExtensionCredential'
  | 'findBrowserExtensionCredential'
  | 'deleteBrowserExtensionCredential'
  | 'deleteBrowserExtensionTokens'
  | 'touchBrowserExtensionCredential'
>;

/** `ABCD-EFGH`: eight characters, shown in two groups. */
export function newCode(): string {
  const chars = Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  );
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** What a person typed, in the stored form: upper case, grouped, spaces and dashes ignored. */
export function normaliseCode(input: string): string {
  const plain = input.toUpperCase().replace(/[\s-]/g, '');
  return `${plain.slice(0, 4)}-${plain.slice(4)}`;
}

export const newToken = (): string => `sbx_${randomBytes(32).toString('base64url')}`;

export async function issueCode(
  store: CredentialStore,
  user: { id: string; tenantId?: string },
  now: number = Date.now(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode();
  const expiresAt = new Date(now + CODE_TTL_MS);
  await store.createBrowserExtensionCredential({
    user: user.id,
    tenantId: user.tenantId,
    kind: 'code',
    secret: code,
    expiresAt,
  });
  return { code, expiresAt };
}

/** Swaps a code for a token. A code works once: it is deleted whether or not the token is used. */
export async function exchangeCode(
  store: CredentialStore,
  input: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: Date } | null> {
  const found = await store.findBrowserExtensionCredential(normaliseCode(input), 'code');
  if (!found) return null;
  await store.deleteBrowserExtensionCredential(found._id);
  // One sign-in per user: connecting again ends the extension's earlier tokens.
  await store.deleteBrowserExtensionTokens(found.user as Types.ObjectId);
  const token = newToken();
  const expiresAt = new Date(now + TOKEN_TTL_MS);
  await store.createBrowserExtensionCredential({
    user: found.user as Types.ObjectId,
    tenantId: found.tenantId,
    kind: 'token',
    secret: token,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function findToken(
  store: CredentialStore,
  token: string,
): Promise<IBrowserExtensionCredential | null> {
  if (!token.startsWith('sbx_')) return null;
  return store.findBrowserExtensionCredential(token, 'token');
}
