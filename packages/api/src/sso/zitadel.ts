import { z } from 'zod';

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ZitadelClientOptions {
  /** The ZITADEL instance's public address, e.g. `https://auth.bdren.ai`. */
  baseUrl: string;
  /** A service user's personal access token. Sent only as a bearer header, never logged. */
  token: string;
  timeoutMs?: number;
}

/** The parts of a ZITADEL human user the migration compares against a Synapse account. */
export interface ZitadelUser {
  userId: string;
  organizationId: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
}

export interface HumanUserInput {
  /** Set explicitly, so a rerun finds the user an earlier run created. */
  userId: string;
  organizationId: string;
  username: string;
  givenName: string;
  familyName: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  /** A bcrypt hash ZITADEL verifies as-is; omitted for accounts without a password. */
  passwordHash?: string;
  /** A base32 RFC 6238 secret (SHA-1, 30 s), so the authenticator app keeps working. */
  totpSecret?: string;
}

export type CreateResult = { status: 'created'; userId: string } | { status: 'exists' };

export interface ZitadelClient {
  getUser: (userId: string) => Promise<ZitadelUser | null>;
  findUsersByEmail: (email: string) => Promise<ZitadelUser[]>;
  findUsersByUsername: (username: string) => Promise<ZitadelUser[]>;
  createHumanUser: (input: HumanUserInput) => Promise<CreateResult>;
}

/** A failed ZITADEL call. Carries the status and ZITADEL's own message, never the request. */
export class ZitadelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ZitadelError';
  }
}

const userSchema = z.object({
  userId: z.string(),
  username: z.string().optional(),
  details: z.object({ resourceOwner: z.string().optional() }).optional(),
  human: z
    .object({
      email: z
        .object({ email: z.string().optional(), isVerified: z.boolean().optional() })
        .optional(),
    })
    .optional(),
});

const listSchema = z.object({ result: z.array(userSchema).optional() });
const getSchema = z.object({ user: userSchema });
const createSchema = z.object({ userId: z.string() });
const errorSchema = z.object({ message: z.string().optional() });

const EQUALS_IGNORE_CASE = 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE';
const DEFAULT_TIMEOUT_MS = 15000;

function toUser(raw: z.infer<typeof userSchema>): ZitadelUser {
  return {
    userId: raw.userId,
    organizationId: raw.details?.resourceOwner ?? '',
    username: raw.username ?? '',
    email: raw.human?.email?.email ?? null,
    emailVerified: raw.human?.email?.isVerified === true,
  };
}

function humanBody(input: HumanUserInput) {
  return {
    userId: input.userId,
    username: input.username,
    organization: { orgId: input.organizationId },
    profile: {
      givenName: input.givenName,
      familyName: input.familyName,
      displayName: input.displayName,
    },
    email: input.emailVerified
      ? { email: input.email, isVerified: true }
      : { email: input.email, returnCode: {} },
    ...(input.passwordHash
      ? { hashedPassword: { hash: input.passwordHash, changeRequired: false } }
      : null),
    ...(input.totpSecret ? { totpSecret: input.totpSecret } : null),
  };
}

/** The few ZITADEL v2 user API calls the migration makes. */
export function createZitadelClient(
  options: ZitadelClientOptions,
  fetchFn: FetchFn = fetch,
): ZitadelClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(method: string, path: string, body?: object): Promise<Response> {
    return fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fail(response: Response, what: string): Promise<never> {
    const text = await response.text().catch(() => '');
    let detail = '';
    try {
      detail = errorSchema.parse(JSON.parse(text)).message ?? '';
    } catch {
      detail = '';
    }
    throw new ZitadelError(
      response.status,
      `${what} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
    );
  }

  async function search(query: object, what: string): Promise<ZitadelUser[]> {
    const response = await call('POST', '/v2/users', { queries: [query] });
    if (!response.ok) {
      return fail(response, what);
    }
    return (listSchema.parse(await response.json()).result ?? []).map(toUser);
  }

  return {
    async getUser(userId) {
      const response = await call('GET', `/v2/users/${encodeURIComponent(userId)}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        return fail(response, 'user lookup');
      }
      return toUser(getSchema.parse(await response.json()).user);
    },
    findUsersByEmail: (email) =>
      search({ emailQuery: { emailAddress: email, method: EQUALS_IGNORE_CASE } }, 'email search'),
    findUsersByUsername: (username) =>
      search(
        { userNameQuery: { userName: username, method: EQUALS_IGNORE_CASE } },
        'username search',
      ),
    async createHumanUser(input) {
      const response = await call('POST', '/v2/users/human', humanBody(input));
      if (response.status === 409) {
        return { status: 'exists' };
      }
      if (!response.ok) {
        return fail(response, 'user creation');
      }
      return { status: 'created', userId: createSchema.parse(await response.json()).userId };
    },
  };
}
