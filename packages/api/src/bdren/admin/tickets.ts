import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IBdrenUploadTicket } from '@librechat/data-schemas';
import type { Model } from 'mongoose';

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 600;
const TICKET_ID = /^[0-9a-f-]{36}$/;

export interface TicketSigner {
  /** Fixed per deployment: `BDREN_UPLOAD_SECRET`, else derived from the product key. */
  secret: () => string | undefined;
  ttlSeconds?: () => number | undefined;
  now?: () => Date;
}

export type TicketFailure = 'invalid' | 'expired' | 'used';

const tickets = (): Model<IBdrenUploadTicket> =>
  mongoose.models.BdrenUploadTicket as Model<IBdrenUploadTicket>;

const unixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export type TicketRequest = Pick<
  IBdrenUploadTicket,
  | 'tenantId'
  | 'organizationId'
  | 'actorUserId'
  | 'actorSubject'
  | 'filename'
  | 'extension'
  | 'sizeBytes'
  | 'title'
  | 'docType'
  | 'documentId'
>;

/**
 * Signed one-file upload URLs. The URL carries the ticket id, the expiry and an HMAC over
 * `id.tenant.expiry`; the ticket record fixes tenant, acting admin, file name and size. The tenant is
 * read from the record, never the URL, so a signature cannot be moved to another tenant. A ticket
 * is spent atomically before the body is read: it works once.
 */
export interface IssuedTicket {
  ticketId: string;
  expires: number;
  signature: string;
  expiresAt: Date;
}

export interface TicketService {
  issue: (request: TicketRequest) => Promise<IssuedTicket | null>;
  verify: (
    ticketId: string,
    expires: string,
    signature: string,
  ) => Promise<{ ticket: IBdrenUploadTicket } | { failure: TicketFailure }>;
  consume: (ticketId: string) => Promise<IBdrenUploadTicket | null>;
}

export function createTicketService({
  secret,
  ttlSeconds,
  now = () => new Date(),
}: TicketSigner): TicketService {
  const sign = (ticketId: string, tenantId: string, expires: number): string | null => {
    const key = secret();
    if (!key) {
      return null;
    }
    return createHmac('sha256', key).update(`v1.${ticketId}.${tenantId}.${expires}`).digest('hex');
  };

  const ttl = (): number => {
    const configured = ttlSeconds?.();
    return configured && configured > 0
      ? Math.min(configured, MAX_TTL_SECONDS)
      : DEFAULT_TTL_SECONDS;
  };

  async function issue(request: TicketRequest): Promise<IssuedTicket | null> {
    const ticketId = randomUUID();
    const expiresAt = new Date(now().getTime() + ttl() * 1000);
    const expires = unixSeconds(expiresAt);
    const signature = sign(ticketId, request.tenantId, expires);
    if (!signature) {
      return null;
    }
    await runAsSystem(() =>
      tickets().create({ ...request, ticketId, expiresAt: new Date(expires * 1000) }),
    );
    return { ticketId, expires, signature, expiresAt: new Date(expires * 1000) };
  }

  /** Checks signature and expiry without spending the ticket. */
  async function verify(
    ticketId: string,
    expires: string,
    signature: string,
  ): Promise<{ ticket: IBdrenUploadTicket } | { failure: TicketFailure }> {
    const expiresNumber = Number(expires);
    if (!TICKET_ID.test(ticketId) || !Number.isInteger(expiresNumber) || !signature) {
      return { failure: 'invalid' };
    }
    const ticket = await runAsSystem(() =>
      tickets().findOne({ ticketId }).lean<IBdrenUploadTicket>().exec(),
    );
    if (!ticket || unixSeconds(ticket.expiresAt) !== expiresNumber) {
      return { failure: 'invalid' };
    }
    const expected = sign(ticket.ticketId, ticket.tenantId, expiresNumber);
    const given = Buffer.from(signature, 'hex');
    const wanted = expected ? Buffer.from(expected, 'hex') : null;
    if (!wanted || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      return { failure: 'invalid' };
    }
    if (ticket.usedAt) {
      return { failure: 'used' };
    }
    if (ticket.expiresAt.getTime() <= now().getTime()) {
      return { failure: 'expired' };
    }
    return { ticket };
  }

  /** Spends the ticket; only the first caller gets it. */
  async function consume(ticketId: string): Promise<IBdrenUploadTicket | null> {
    const at = now();
    return runAsSystem(() =>
      tickets()
        .findOneAndUpdate(
          { ticketId, usedAt: null, expiresAt: { $gt: at } },
          { $set: { usedAt: at } },
          { new: true },
        )
        .lean<IBdrenUploadTicket>()
        .exec(),
    );
  }

  return { issue, verify, consume };
}
