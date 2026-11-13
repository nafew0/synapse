import { InstitutionMembershipStatuses, logger, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { IInstitution, IUser } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { ServerRequest } from '~/types';
import type { CredentialStore } from './credentials';
import { findToken } from './credentials';

export type ExtensionMiddleware = (
  req: ExtensionRequest,
  res: Response,
  next: NextFunction,
) => Promise<void>;

export type ExtensionRequest = ServerRequest & {
  /** The token credential this request signed in with. */
  extensionCredentialId?: Types.ObjectId;
};

const refuse = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

/**
 * Signs a request in with an extension token. The token is found across tenants, since its tenant is not known yet;
 * everything after runs in the user's own tenant context, so later queries stay scoped to their institution.
 */
export function createExtensionAuth(deps: {
  store: CredentialStore;
  findUser: (filter: { _id: Types.ObjectId }) => Promise<IUser | null>;
}): ExtensionMiddleware {
  return async (req: ExtensionRequest, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return refuse(res, 401, 'signed_out', 'Sign in to Synapse in the extension.');
    try {
      const credential = await runAsSystem(() => findToken(deps.store, token));
      if (!credential)
        return refuse(
          res,
          401,
          'signed_out',
          'Your sign-in has expired. Connect to Synapse again.',
        );
      const user = await runAsSystem(() => deps.findUser({ _id: credential.user }));
      if (!user)
        return refuse(res, 401, 'signed_out', 'Your Synapse account was not found. Connect again.');
      // A token outlives a suspension or a removal by up to 30 days, so the account is checked on every request.
      if (
        (user.membershipStatus !== undefined &&
          user.membershipStatus !== InstitutionMembershipStatuses.ACTIVE) ||
        user.agentTriggerDeletionStartedAt != null
      ) {
        void runAsSystem(() => deps.store.deleteBrowserExtensionTokens(user._id)).catch(
          () => undefined,
        );
        return refuse(res, 401, 'signed_out', 'Your Synapse account is no longer active.');
      }
      void runAsSystem(() => deps.store.touchBrowserExtensionCredential(credential._id)).catch(
        () => undefined,
      );
      user.id = String(user._id);
      req.user = user;
      req.extensionCredentialId = credential._id;
      const current = tenantStorage.getStore() ?? {};
      tenantStorage.run({ ...current, tenantId: user.tenantId, userId: user.id }, next);
    } catch (error) {
      logger.error(
        '[browserExtension] sign-in check failed',
        error instanceof Error ? error.message : '',
      );
      refuse(res, 500, 'server_error', 'Synapse could not check your sign-in. Try again.');
    }
  };
}

/** Lets a request through only when the user's institution has the extension switched on. */
export function createExtensionEnabledCheck(deps: {
  getInstitutionByTenantId: (tenantId: string) => Promise<IInstitution | null>;
}): ExtensionMiddleware {
  return async (req: ExtensionRequest, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.user?.tenantId;
    const institution = tenantId ? await deps.getInstitutionByTenantId(tenantId) : null;
    if (!institution?.browserControl?.extensionEnabled) {
      return refuse(
        res,
        403,
        'extension_disabled',
        'Browser tasks are not switched on for your institution.',
      );
    }
    next();
  };
}
