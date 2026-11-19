import { ErrorTypes } from 'librechat-data-provider';
import type { TUserChatAccess } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

export type ChatAccessDenial = { type: ErrorTypes.CHAT_ACCESS_ENDED; info?: string };

type DenyRequest = (
  req: ServerRequest,
  res: Response,
  denial: ChatAccessDenial,
) => Promise<unknown>;

/**
 * The refusal for a request whose institution has ended chat access, or `null` while chat is open.
 * Reads `req.institution`, which the tenant middleware already loaded, so it costs no database read.
 */
export function getChatAccessDenial(req: ServerRequest): ChatAccessDenial | null {
  const access = req.institution?.chatAccess;
  if (!access?.ended) {
    return null;
  }
  const info = access.message?.trim();
  return info
    ? { type: ErrorTypes.CHAT_ACCESS_ENDED, info }
    : { type: ErrorTypes.CHAT_ACCESS_ENDED };
}

/** Refuses new chat turns, before any model is called, for members of an institution whose access has ended. */
export function createChatAccessGuard(deny: DenyRequest) {
  return async (req: ServerRequest, res: Response, next: NextFunction): Promise<void> => {
    const denial = getChatAccessDenial(req);
    if (!denial) {
      next();
      return;
    }
    await deny(req, res, denial);
  };
}

const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether `value` is an empty contact, an email address, or an http(s) link. */
export function isChatAccessContact(value: string): boolean {
  const contact = value.trim();
  if (!contact || CONTACT_EMAIL.test(contact)) {
    return true;
  }
  try {
    const url = new URL(contact);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** What the signed-in user is told about their institution's chat access: nothing while it is open. */
export function toUserChatAccess(
  access?: NonNullable<ServerRequest['institution']>['chatAccess'],
): TUserChatAccess | undefined {
  if (!access?.ended) {
    return undefined;
  }
  return {
    ended: true,
    ...(access.message?.trim() && { message: access.message.trim() }),
    ...(access.contact?.trim() && { contact: access.contact.trim() }),
  };
}
