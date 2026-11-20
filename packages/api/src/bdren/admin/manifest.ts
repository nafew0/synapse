import type { Request, Response } from 'express';

export interface ManifestSection {
  key: string;
  title: string;
  paths: Record<string, string>;
}

/** Console sections Synapse offers to institution admins; `{orgId}` is the bdren.ai organization id. */
export const ADMIN_SECTIONS: readonly ManifestSection[] = [
  {
    key: 'knowledge',
    title: 'Knowledge base',
    paths: {
      list: 'GET /api/bdren/institutions/{orgId}/knowledge',
      uploadUrl: 'POST /api/bdren/institutions/{orgId}/knowledge/upload-url',
      update: 'PATCH /api/bdren/institutions/{orgId}/knowledge/{id}',
      remove: 'DELETE /api/bdren/institutions/{orgId}/knowledge/{id}',
      retry: 'POST /api/bdren/institutions/{orgId}/knowledge/{id}/retry',
    },
  },
  {
    key: 'access-groups',
    title: 'Access groups',
    paths: {
      list: 'GET /api/bdren/institutions/{orgId}/groups',
      create: 'POST /api/bdren/institutions/{orgId}/groups',
      update: 'PATCH /api/bdren/institutions/{orgId}/groups/{id}',
      remove: 'DELETE /api/bdren/institutions/{orgId}/groups/{id}',
      agents: 'GET /api/bdren/institutions/{orgId}/agents',
      members: 'GET /api/bdren/institutions/{orgId}/members',
    },
  },
  {
    key: 'usage',
    title: 'Usage',
    paths: { daily: 'GET /api/bdren/institutions/{orgId}/usage/daily?start&end' },
  },
];

export function manifestHandler(_req: Request, res: Response): void {
  res.json({ app: 'synapse', version: 1, sections: ADMIN_SECTIONS });
}
