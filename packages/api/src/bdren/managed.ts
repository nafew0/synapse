import type { NextFunction, Request, Response } from 'express';
import type { BdrenConfig } from './types';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses changes to Synapse's own packages and assignments while bdren.ai owns them, so the two
 * catalogues cannot drift. Reads still work: the admin pages show what is mirrored.
 */
export function requirePackagesEditable(config: BdrenConfig) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    if (!config.enabled || READ_METHODS.has(req.method)) {
      return next();
    }
    return res.status(409).json({
      error: 'Packages are managed in bdren.ai',
      code: 'PACKAGES_MANAGED_BY_BDREN',
      manageUrl: config.upgradeUrl,
    });
  };
}
