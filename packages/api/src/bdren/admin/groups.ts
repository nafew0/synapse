import mongoose, { Types } from 'mongoose';
import { InstitutionMembershipStatuses, logger, runAsSystem } from '@librechat/data-schemas';
import {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { IAgent, IGroup, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Model } from 'mongoose';
import type { AdminRequest } from './types';
import type { Auditor } from './audit';
import { normalizeOpenIdIssuer } from '~/auth/openid';

const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;
const MAX_MEMBERS = 2000;
const MAX_AGENTS = 100;
const DUPLICATE_KEY = 11000;

type Id = string | Types.ObjectId;

export interface GroupDeps {
  audit: Auditor;
  grantPermission: (args: {
    principalType: string;
    principalId: Id;
    tenantId: string;
    resourceType: string;
    resourceId: Id;
    accessRoleId: string;
    grantedBy: string;
  }) => Promise<unknown>;
  findRoleByIdentifier: (id: string) => Promise<{ _id: Types.ObjectId } | null>;
  deleteConfig: (principalType: string, principalId: Id) => Promise<unknown>;
  issuer: () => string | undefined;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AgentLean = Pick<IAgent, 'id' | 'name' | 'description' | 'edges' | 'tenantId'> & {
  _id: Types.ObjectId;
};
type UserLean = Pick<IUser, 'openidId' | 'name' | 'email' | 'idOnTheSource'> & {
  _id: Types.ObjectId;
};

const models = () => ({
  Group: mongoose.models.Group as Model<IGroup>,
  User: mongoose.models.User as Model<IUser>,
  Agent: mongoose.models.Agent as Model<IAgent>,
  AclEntry: mongoose.models.AclEntry as Model<{
    principalType: string;
    principalId: Types.ObjectId;
    resourceType: string;
    resourceId: Types.ObjectId;
    permBits: number;
    roleId?: Types.ObjectId;
    tenantId?: string;
  }>,
});

const activeFilter = (tenantId: string) => ({
  tenantId,
  $or: [
    { membershipStatus: InstitutionMembershipStatuses.ACTIVE },
    { membershipStatus: { $exists: false } },
    { membershipStatus: null },
  ],
});

const AUDIENCE_KIND = 'tenant_all_active_members';

/**
 * Agents an institution may hand to its groups: its own, and the platform agents the superadmin has
 * enabled for it (those on the tenant-wide audience). Never delegated specialists as a choice.
 */
async function grantableAgents(tenantId: string) {
  const { Group, AclEntry } = models();
  const audience = await runAsSystem(() =>
    Group.findOne({ tenantId, managedKind: AUDIENCE_KIND })
      .select('_id')
      .lean<{ _id: Types.ObjectId }>()
      .exec(),
  );
  const entries = audience
    ? await runAsSystem(() =>
        AclEntry.find({
          principalType: PrincipalType.GROUP,
          principalId: audience._id,
          resourceType: ResourceType.AGENT,
          tenantId,
        })
          .select('resourceId permBits')
          .lean()
          .exec(),
      )
    : [];
  const enabled = entries
    .filter((e) => (e.permBits & PermissionBits.VIEW) !== 0)
    .map((e) => e.resourceId);
  return {
    enabled,
    filter: {
      orchestrationOnly: { $ne: true },
      $or: [{ tenantId }, { _id: { $in: enabled } }],
    },
    specialistFilter: { $or: [{ tenantId }, { _id: { $in: enabled } }] },
  };
}

const memberKey = (user: UserLean): string => user.idOnTheSource || user._id.toString();

const customGroups = (tenantId: string) => ({
  tenantId,
  source: 'local',
  managedKind: { $exists: false },
});

const specialistIdsOf = (agent: AgentLean): string[] => [
  ...new Set(
    (agent.edges ?? [])
      .flatMap((edge) => (Array.isArray(edge?.to) ? edge.to : [edge?.to]))
      .filter((to): to is string => typeof to === 'string' && to !== agent.id),
  ),
];

const text = (
  value: unknown,
  max: number,
  field: string,
  required: boolean,
): string | undefined => {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new HttpFailure(400, `${field} must be a string of at most ${max} characters`);
  }
  return value.trim();
};

const stringList = (value: unknown, max: number, field: string): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== 'string')) {
    throw new HttpFailure(400, `${field} must be a list of at most ${max} strings`);
  }
  return [...new Set(value as string[])];
};

type GroupHandler = (req: AdminRequest, res: Response) => Promise<void>;

export interface GroupHandlers {
  list: GroupHandler;
  get: GroupHandler;
  create: GroupHandler;
  update: GroupHandler;
  remove: GroupHandler;
  agents: GroupHandler;
  members: GroupHandler;
}

export function createGroupHandlers(deps: GroupDeps): GroupHandlers {
  const { audit } = deps;

  async function resolveMembers(tenantId: string, subjects: string[]): Promise<UserLean[]> {
    if (subjects.length === 0) {
      return [];
    }
    const issuer = normalizeOpenIdIssuer(deps.issuer());
    if (!issuer) {
      throw new HttpFailure(503, 'bdren.ai issuer is not configured');
    }
    const users = await runAsSystem(() =>
      models()
        .User.find({ ...activeFilter(tenantId), openidId: { $in: subjects }, openidIssuer: issuer })
        .select('openidId name email idOnTheSource')
        .lean<UserLean[]>()
        .exec(),
    );
    const found = new Set(users.map((u) => u.openidId));
    const missing = subjects.filter((s) => !found.has(s));
    if (missing.length) {
      throw new HttpFailure(400, `Not active members of this institution: ${missing.join(', ')}`);
    }
    return users;
  }

  async function resolveAgents(tenantId: string, agentIds: string[]) {
    if (agentIds.length === 0) {
      return { masters: [] as AgentLean[], specialists: [] as AgentLean[] };
    }
    const scope = await grantableAgents(tenantId);
    const masters = await runAsSystem(() =>
      models()
        .Agent.find({ id: { $in: agentIds }, ...scope.filter })
        .select('_id id name description edges tenantId')
        .lean<AgentLean[]>()
        .exec(),
    );
    const known = new Set(masters.map((a) => a.id));
    const missing = agentIds.filter((id) => !known.has(id));
    if (missing.length) {
      throw new HttpFailure(400, `Agents not available to this institution: ${missing.join(', ')}`);
    }
    const specialistIds = [...new Set(masters.flatMap(specialistIdsOf))];
    const specialists = specialistIds.length
      ? await runAsSystem(() =>
          models()
            .Agent.find({ id: { $in: specialistIds }, ...scope.specialistFilter })
            .select('_id id')
            .lean<AgentLean[]>()
            .exec(),
        )
      : [];
    if (specialists.length !== specialistIds.length) {
      throw new HttpFailure(409, 'Some delegated agents are not available to this institution');
    }
    return { masters, specialists };
  }

  async function groupAgents(tenantId: string, groupIds: Types.ObjectId[]) {
    const entries = await runAsSystem(() =>
      models()
        .AclEntry.find({
          principalType: PrincipalType.GROUP,
          principalId: { $in: groupIds },
          resourceType: ResourceType.AGENT,
          tenantId,
        })
        .select('principalId resourceId permBits')
        .lean()
        .exec(),
    );
    const visible = entries.filter((e) => (e.permBits & PermissionBits.VIEW) !== 0);
    const scope = await grantableAgents(tenantId);
    const agents = await runAsSystem(() =>
      models()
        .Agent.find({
          _id: { $in: visible.map((e) => e.resourceId) },
          ...scope.filter,
        })
        .select('_id id name')
        .lean<AgentLean[]>()
        .exec(),
    );
    const byObjectId = new Map(agents.map((a) => [a._id.toString(), a]));
    const result = new Map<string, { id: string; name: string }[]>();
    for (const entry of visible) {
      const agent = byObjectId.get(entry.resourceId.toString());
      if (!agent) {
        continue;
      }
      const key = entry.principalId.toString();
      result.set(key, [...(result.get(key) ?? []), { id: agent.id, name: agent.name ?? agent.id }]);
    }
    return result;
  }

  async function present(tenantId: string, groups: (IGroup & { _id: Types.ObjectId })[]) {
    const keys = [...new Set(groups.flatMap((g) => (g.memberIds ?? []).map(String)))];
    const objectIds = keys.filter((k) => Types.ObjectId.isValid(k));
    const users = keys.length
      ? await runAsSystem(() =>
          models()
            .User.find({
              tenantId,
              $or: [{ idOnTheSource: { $in: keys } }, { _id: { $in: objectIds } }],
            })
            .select('openidId name email idOnTheSource')
            .lean<UserLean[]>()
            .exec(),
        )
      : [];
    const byKey = new Map<string, UserLean>();
    users.forEach((u) => {
      byKey.set(memberKey(u), u);
      byKey.set(u._id.toString(), u);
    });
    const agents = await groupAgents(
      tenantId,
      groups.map((g) => g._id),
    );
    return groups.map((g) => ({
      id: g._id.toString(),
      name: g.name,
      description: g.description ?? '',
      members: (g.memberIds ?? []).flatMap((key) => {
        const u = byKey.get(String(key));
        return u
          ? [
              {
                userId: u._id.toString(),
                subject: u.openidId ?? null,
                name: u.name,
                email: u.email,
              },
            ]
          : [];
      }),
      agents: agents.get(g._id.toString()) ?? [],
    }));
  }

  async function writeAgents(
    tenantId: string,
    groupId: Types.ObjectId,
    agentIds: string[],
    actorId: string,
  ) {
    const { masters, specialists } = await resolveAgents(tenantId, agentIds);
    const [agentViewer, remoteViewer] = await Promise.all([
      deps.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER),
      deps.findRoleByIdentifier(AccessRoleIds.REMOTE_AGENT_VIEWER),
    ]);
    const principal = { principalType: PrincipalType.GROUP, principalId: groupId, tenantId };
    const wantedMasters = new Set(masters.map((a) => a._id.toString()));
    const wantedSpecialists = new Set(specialists.map((a) => a._id.toString()));
    const existing = await runAsSystem(() =>
      models()
        .AclEntry.find({
          principalType: PrincipalType.GROUP,
          principalId: groupId,
          tenantId,
          resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
          roleId: { $in: [agentViewer?._id, remoteViewer?._id].filter(Boolean) },
        })
        .select('_id resourceType resourceId')
        .lean()
        .exec(),
    );
    const keep = (entry: (typeof existing)[number]): boolean => {
      const id = entry.resourceId.toString();
      return entry.resourceType === ResourceType.REMOTE_AGENT
        ? wantedSpecialists.has(id)
        : wantedMasters.has(id) || wantedSpecialists.has(id);
    };
    const grant = (resourceType: string, resourceId: Id, accessRoleId: string) =>
      deps.grantPermission({
        ...principal,
        resourceType,
        resourceId,
        accessRoleId,
        grantedBy: actorId,
      });
    await Promise.all([
      ...masters.map((a) => grant(ResourceType.AGENT, a._id, AccessRoleIds.AGENT_VIEWER)),
      ...specialists.flatMap((a) => [
        grant(ResourceType.AGENT, a._id, AccessRoleIds.AGENT_VIEWER),
        grant(ResourceType.REMOTE_AGENT, a._id, AccessRoleIds.REMOTE_AGENT_VIEWER),
      ]),
    ]);
    const stale = existing.filter((e) => !keep(e)).map((e) => e._id);
    if (stale.length) {
      await runAsSystem(() =>
        models()
          .AclEntry.deleteMany({ _id: { $in: stale }, tenantId })
          .exec(),
      );
    }
  }

  async function findGroup(tenantId: string, id: string) {
    const group = Types.ObjectId.isValid(id)
      ? await runAsSystem(() =>
          models()
            .Group.findOne({ _id: id, ...customGroups(tenantId) })
            .lean<IGroup & { _id: Types.ObjectId }>()
            .exec(),
        )
      : null;
    if (!group) {
      throw new HttpFailure(404, 'Group not found');
    }
    return group;
  }

  const handle =
    (
      run: (req: AdminRequest, res: Response, tenantId: string) => Promise<unknown>,
      failedAction?: string,
    ) =>
    async (req: AdminRequest, res: Response): Promise<void> => {
      try {
        await run(req, res, req.bdren!.tenantId);
      } catch (error) {
        if (failedAction) {
          await audit(
            req,
            failedAction,
            { type: 'group', id: req.params.groupId },
            { reason: error instanceof HttpFailure ? error.message.slice(0, 200) : 'error' },
            'failure',
          );
        }
        if (error instanceof HttpFailure) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        if ((error as { code?: number }).code === DUPLICATE_KEY) {
          res.status(409).json({ error: 'A group with that name already exists' });
          return;
        }
        logger.error('[bdren/admin] group request failed', error);
        res.status(500).json({ error: 'Group request failed' });
      }
    };

  const list = handle(async (_req, res, tenantId) => {
    const groups = await runAsSystem(() =>
      models()
        .Group.find(customGroups(tenantId))
        .sort({ name: 1 })
        .lean<(IGroup & { _id: Types.ObjectId })[]>()
        .exec(),
    );
    res.json({ groups: await present(tenantId, groups) });
  });

  const get = handle(async (req, res, tenantId) => {
    const group = await findGroup(tenantId, String(req.params.groupId));
    res.json({ group: (await present(tenantId, [group]))[0] });
  });

  const create = handle(async (req, res, tenantId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = text(body.name, MAX_NAME, 'name', true)!;
    const description = text(body.description, MAX_DESCRIPTION, 'description', false);
    const subjects = stringList(body.members, MAX_MEMBERS, 'members') ?? [];
    const agentIds = stringList(body.agents, MAX_AGENTS, 'agents') ?? [];
    const users = await resolveMembers(tenantId, subjects);
    await resolveAgents(tenantId, agentIds);
    const created = await runAsSystem(() =>
      models().Group.create({
        name,
        description,
        source: 'local',
        tenantId,
        memberIds: users.map(memberKey),
      }),
    );
    const group = created.toObject() as IGroup & { _id: Types.ObjectId };
    await writeAgents(tenantId, group._id, agentIds, req.bdren!.actor.userId);
    res.status(201).json({ group: (await present(tenantId, [group]))[0] });
    await audit(
      req,
      'institution.access_group_created',
      { type: 'group', id: String(group._id), name },
      {
        members: users.length,
        agents: agentIds.length,
      },
    );
  }, 'institution.access_group_created');

  const update = handle(async (req, res, tenantId) => {
    const group = await findGroup(tenantId, String(req.params.groupId));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = text(body.name, MAX_NAME, 'name', false);
    const description = text(body.description, MAX_DESCRIPTION, 'description', false);
    const subjects = stringList(body.members, MAX_MEMBERS, 'members');
    const agentIds = stringList(body.agents, MAX_AGENTS, 'agents');
    const users = subjects ? await resolveMembers(tenantId, subjects) : undefined;
    if (agentIds) {
      await resolveAgents(tenantId, agentIds);
    }
    const set: Partial<IGroup> = {
      ...(name ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(users ? { memberIds: users.map(memberKey) } : {}),
    };
    if (Object.keys(set).length) {
      await runAsSystem(() =>
        models()
          .Group.updateOne({ _id: group._id, ...customGroups(tenantId) }, { $set: set })
          .exec(),
      );
    }
    if (agentIds) {
      await writeAgents(tenantId, group._id, agentIds, req.bdren!.actor.userId);
    }
    const fresh = await findGroup(tenantId, String(group._id));
    res.json({ group: (await present(tenantId, [fresh]))[0] });
    await audit(
      req,
      'institution.access_group_updated',
      { type: 'group', id: String(group._id), name: fresh.name },
      {
        renamed: Boolean(name),
        members: users?.length ?? null,
        agents: agentIds?.length ?? null,
      },
    );
  }, 'institution.access_group_updated');

  const remove = handle(async (req, res, tenantId) => {
    const group = await findGroup(tenantId, String(req.params.groupId));
    await runAsSystem(() =>
      models()
        .Group.deleteOne({ _id: group._id, ...customGroups(tenantId) })
        .exec(),
    );
    await runAsSystem(() =>
      models()
        .AclEntry.deleteMany({
          principalType: PrincipalType.GROUP,
          principalId: group._id,
          tenantId,
        })
        .exec(),
    );
    await deps.deleteConfig(PrincipalType.GROUP, group._id).catch(() => undefined);
    res.status(204).end();
    await audit(req, 'institution.access_group_deleted', {
      type: 'group',
      id: String(group._id),
      name: group.name,
    });
  }, 'institution.access_group_deleted');

  const agents = handle(async (_req, res, tenantId) => {
    const scope = await grantableAgents(tenantId);
    const found = await runAsSystem(() =>
      models()
        .Agent.find(scope.filter)
        .select('id name description')
        .sort({ name: 1 })
        .lean<AgentLean[]>()
        .exec(),
    );
    res.json({
      agents: found.map((a) => ({ id: a.id, name: a.name, description: a.description ?? '' })),
    });
  });

  const members = handle(async (_req, res, tenantId) => {
    const users = await runAsSystem(() =>
      models()
        .User.find(activeFilter(tenantId))
        .select('openidId name email')
        .limit(5000)
        .lean<UserLean[]>()
        .exec(),
    );
    res.json({
      members: users.map((u) => ({
        userId: u._id.toString(),
        subject: u.openidId ?? null,
        name: u.name,
        email: u.email,
      })),
    });
  });

  return { list, get, create, update, remove, agents, members };
}
