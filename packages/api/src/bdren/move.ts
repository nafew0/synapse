import { randomUUID } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import {
  logger,
  runAsSystem,
  supportsTransactions,
  INSTITUTION_ADMIN_ROLE,
  InstitutionMembershipStatuses,
} from '@librechat/data-schemas';
import type {
  IUser,
  IMemberMove,
  MemberMovePlan,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { ClientSession, Model, UpdateQuery, mongo } from 'mongoose';
import type { MemberRecord } from './place';

type Filter = mongo.Filter<mongo.Document>;

/** A move of one person between tenants; `null` is no tenant, an individual. */
export interface MoveRequest {
  userId: string;
  from: string | null;
  to: string | null;
  reason: string;
}

export type MoveRefusal = 'not_found' | 'staff' | 'stale' | 'full' | 'duplicate_account';

export type MoveOutcome =
  | {
      status: 'moved';
      user: MemberRecord;
      from: string | null;
      to: string | null;
      moved: Record<string, number>;
      conflicts: Record<string, number>;
    }
  /** The person is already where the request would put them. */
  | { status: 'noop' }
  /** Another trigger is moving them right now. */
  | { status: 'busy' }
  | { status: 'refused'; reason: MoveRefusal };

export interface MoverDeps {
  /** Takes a seat in an institution; `false` when it is full. */
  reserveSeat: (tenantId: string) => Promise<boolean>;
  releaseSeat: (tenantId: string) => Promise<void>;
  /** Brings the tenant's agent audience in line with the member's current state. */
  syncMember: (args: { tenantId: string; userId: string }) => Promise<unknown>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
  /** How long one trigger may hold a move before another may resume it. */
  leaseMs?: number;
  now?: () => Date;
  /** Whether the deployment runs transactions; probed once from the connection by default. */
  transactions?: () => Promise<boolean>;
}

export type MemberMover = (request: MoveRequest) => Promise<MoveOutcome>;

interface StepContext {
  userId: string;
  oid: Types.ObjectId;
  from: string | null;
  to: string | null;
  plan: MemberMovePlan;
  memberKeys: string[];
  session?: ClientSession;
}

type StepKind = 'retenant' | 'files' | 'revoke' | 'unenrol';

interface Step {
  name: string;
  model: string;
  kind?: StepKind;
  /** The field naming the person; absent when `where` alone selects the records. */
  owner?: string;
  where?: (ctx: StepContext) => Filter | Promise<Filter>;
  /** Only when leaving an institution. */
  leaveOnly?: boolean;
}

interface StepResult {
  moved: number;
  conflicts: number;
}

const DUPLICATE_KEY = 11000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const SERVICE_ACTOR = { type: 'service', name: 'bdren.ai' } as const;
const PLATFORM_ROLES = new Set<string>([SystemRoles.ADMIN, 'PLATFORM_SUPERADMIN']);
/** Every resource kind the ACL can share, with the field naming its owner. */
const SHAREABLE: ReadonlyArray<readonly [string, string]> = [
  ['Agent', 'author'],
  ['PromptGroup', 'author'],
  ['MCPServer', 'author'],
  ['Skill', 'author'],
  ['SharedLink', 'user'],
];

const toIds = (ids: string[]): Types.ObjectId[] => ids.map((id) => new Types.ObjectId(id));

/**
 * Collections holding a person's own work, in the order they move. The ACL steps come after the
 * resources they protect; revoking and unenrolling run last and only on a leave.
 */
const STEPS: ReadonlyArray<Step> = [
  { name: 'conversations', model: 'Conversation', owner: 'user' },
  { name: 'messages', model: 'Message', owner: 'user' },
  { name: 'toolCalls', model: 'ToolCall', owner: 'user' },
  { name: 'sharedLinks', model: 'SharedLink', owner: 'user' },
  { name: 'conversationTags', model: 'ConversationTag', owner: 'user' },
  { name: 'chatProjects', model: 'ChatProject', owner: 'user' },
  { name: 'presets', model: 'Preset', owner: 'user' },
  { name: 'memories', model: 'MemoryEntry', owner: 'userId' },
  {
    name: 'files',
    model: 'File',
    owner: 'user',
    kind: 'files',
    where: ({ plan }) => ({ file_id: { $nin: plan.keptFiles } }),
  },
  {
    name: 'agents',
    model: 'Agent',
    owner: 'author',
    where: ({ plan }) => ({ _id: { $nin: toIds(plan.keptAgents) } }),
  },
  {
    name: 'actions',
    model: 'Action',
    owner: 'user',
    where: ({ plan }) => ({
      $or: [{ agent_id: { $in: plan.movedAgentIds } }, { agent_id: null }],
    }),
  },
  { name: 'agentApiKeys', model: 'AgentApiKey', owner: 'userId' },
  { name: 'assistants', model: 'Assistant', owner: 'user' },
  {
    name: 'promptGroups',
    model: 'PromptGroup',
    owner: 'author',
    where: ({ plan }) => ({ _id: { $nin: toIds(plan.keptPromptGroups) } }),
  },
  {
    name: 'prompts',
    model: 'Prompt',
    owner: 'author',
    where: ({ plan }) => ({ groupId: { $nin: toIds(plan.keptPromptGroups) } }),
  },
  {
    name: 'mcpServers',
    model: 'MCPServer',
    owner: 'author',
    where: ({ plan }) => ({ _id: { $nin: toIds(plan.keptMcpServers) } }),
  },
  {
    name: 'skills',
    model: 'Skill',
    owner: 'author',
    where: ({ plan }) => ({ _id: { $nin: toIds(plan.keptSkills) } }),
  },
  {
    name: 'skillFiles',
    model: 'SkillFile',
    where: ({ plan }) => ({ skillId: { $in: toIds(plan.movedSkills) } }),
  },
  { name: 'keys', model: 'Key', owner: 'userId' },
  { name: 'pluginAuths', model: 'PluginAuth', owner: 'userId' },
  { name: 'toolFavorites', model: 'ToolFavorite', owner: 'user' },
  { name: 'sessions', model: 'Session', owner: 'user' },
  { name: 'tokens', model: 'Token', owner: 'userId' },
  { name: 'balances', model: 'Balance', owner: 'user' },
  {
    name: 'aclEntries',
    model: 'AclEntry',
    where: async (ctx) => ({ resourceId: { $in: await movedResources(ctx) } }),
  },
  { name: 'aclRevoked', model: 'AclEntry', kind: 'revoke', leaveOnly: true },
  { name: 'groups', model: 'Group', kind: 'unenrol', leaveOnly: true },
];

/** The collection names a move touches, for the documentation and the tests. */
export const MOVED_COLLECTIONS: ReadonlyArray<string> = STEPS.map((step) => step.name);

const model = (name: string): Model<mongo.Document> =>
  mongoose.models[name] as Model<mongo.Document>;
const users = (): Model<IUser> => mongoose.models.User as Model<IUser>;
const moves = (): Model<IMemberMove> => mongoose.models.MemberMove as Model<IMemberMove>;

/** The person's id in the type the owner field stores. */
function ownerValue(modelName: string, field: string, ctx: StepContext): Types.ObjectId | string {
  return model(modelName).schema.path(field)?.instance === 'ObjectId' ? ctx.oid : ctx.userId;
}

/** Shareable resources of the person that are now in the target tenant: the ones that moved. */
async function movedResources(ctx: StepContext): Promise<Types.ObjectId[]> {
  const found = await Promise.all(
    SHAREABLE.map(([name, field]) =>
      model(name)
        .collection.find(
          { [field]: ownerValue(name, field, ctx), tenantId: ctx.to },
          { projection: { _id: 1 }, session: ctx.session },
        )
        .toArray(),
    ),
  );
  return found.flat().map((doc) => doc._id as Types.ObjectId);
}

/** Audit metadata is flat, so per-collection counts become `<prefix><collection>` keys. */
function prefixed(prefix: string, counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([name, count]) => [`${prefix}${name}`, count]),
  );
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: number })?.code === DUPLICATE_KEY;
}

function isActiveMember(user: Pick<IUser, 'membershipStatus'>): boolean {
  return (
    user.membershipStatus == null || user.membershipStatus === InstitutionMembershipStatuses.ACTIVE
  );
}

function retenant(to: string | null): mongo.UpdateFilter<mongo.Document> {
  return to ? { $set: { tenantId: to } } : { $unset: { tenantId: '' } };
}

/** File records keep pointing at the stored object, whose key may name the old tenant. */
function retenantFiles(from: string | null, to: string | null): mongo.Document[] {
  return [
    {
      $set: {
        storageTenantId: {
          $cond: [
            { $eq: [{ $type: '$storageTenantId' }, 'missing'] },
            { $literal: from },
            '$storageTenantId',
          ],
        },
      },
    },
    to ? { $set: { tenantId: to } } : { $unset: 'tenantId' },
  ];
}

async function stepFilter(step: Step, ctx: StepContext): Promise<Filter> {
  const filter: Filter = { tenantId: ctx.from };
  if (step.owner) {
    filter[step.owner] = ownerValue(step.model, step.owner, ctx);
  }
  return step.where ? { ...filter, ...(await step.where(ctx)) } : filter;
}

/**
 * Applies one step. Inside a transaction a duplicate key aborts it (the caller falls back to the
 * sequential path); outside one each clashing record is left where it is and counted.
 */
async function runStep(step: Step, ctx: StepContext): Promise<StepResult> {
  const collection = model(step.model).collection;
  const { session } = ctx;
  if (step.kind === 'revoke') {
    const result = await collection.deleteMany(
      { tenantId: ctx.from, principalType: 'user', principalId: ctx.oid },
      { session },
    );
    return { moved: result.deletedCount, conflicts: 0 };
  }
  if (step.kind === 'unenrol') {
    const result = await model(step.model)
      .updateMany(
        { tenantId: ctx.from, memberIds: { $in: ctx.memberKeys } },
        { $pull: { memberIds: { $in: ctx.memberKeys } } },
        { session },
      )
      .exec();
    return { moved: result.modifiedCount, conflicts: 0 };
  }
  const filter = await stepFilter(step, ctx);
  const update = step.kind === 'files' ? retenantFiles(ctx.from, ctx.to) : retenant(ctx.to);
  try {
    const result = await collection.updateMany(filter, update, { session });
    return { moved: result.modifiedCount, conflicts: 0 };
  } catch (error) {
    if (!isDuplicate(error) || session) {
      throw error;
    }
  }
  const ids = await collection.find(filter, { projection: { _id: 1 } }).toArray();
  let moved = 0;
  let conflicts = 0;
  for (const { _id } of ids) {
    try {
      moved += (await collection.updateOne({ ...filter, _id }, update)).modifiedCount;
    } catch (error) {
      if (!isDuplicate(error)) {
        throw error;
      }
      conflicts += 1;
    }
  }
  if (conflicts > 0) {
    logger.warn(
      `[bdren] move of ${ctx.userId}: ${conflicts} ${step.name} clash with records in ${ctx.to ?? 'no tenant'}; left in place`,
    );
  }
  return { moved, conflicts };
}

class LeaseLost extends Error {
  constructor() {
    super('member move lease lost');
    this.name = 'LeaseLost';
  }
}

/**
 * Whether a user is platform staff: a platform role, or an active `PlatformAdmin` row by id or
 * email. Staff register without an institution like individuals do, but are never moved.
 */
export async function isPlatformStaff(
  userId: string,
  role?: string | null,
  email?: string | null,
): Promise<boolean> {
  if (role && PLATFORM_ROLES.has(role)) {
    return true;
  }
  const admin = await runAsSystem(() =>
    mongoose.models.PlatformAdmin?.exists({
      active: true,
      $or: [{ userId }, ...(email ? [{ email: email.toLowerCase() }] : [])],
    }).exec(),
  );
  return admin != null;
}

/** Plans which of the person's items stay behind. Only a leave keeps anything: what they shared there. */
async function makePlan(userId: string, from: string | null): Promise<MemberMovePlan> {
  const oid = new Types.ObjectId(userId);
  const own = (name: string, select: string) =>
    model(name)
      .find({ author: oid, tenantId: from })
      .select(select)
      .lean<Array<{ _id: Types.ObjectId; id?: string; tool_resources?: ToolResources }>>()
      .exec();
  const [agents, groups, servers, skills] = await runAsSystem(() =>
    Promise.all([
      own('Agent', '_id id tool_resources'),
      own('PromptGroup', '_id'),
      own('MCPServer', '_id'),
      own('Skill', '_id'),
    ]),
  );
  if (from == null) {
    return {
      keptAgents: [],
      keptPromptGroups: [],
      keptMcpServers: [],
      keptSkills: [],
      keptFiles: [],
      movedAgentIds: agents.flatMap((agent) => (agent.id ? [agent.id] : [])),
      movedSkills: skills.map((skill) => String(skill._id)),
    };
  }
  const ownGroupIds = groups.map((group) => group._id);
  const [sharedIds, foreignGroups] = await runAsSystem(() =>
    Promise.all([
      model('AclEntry').distinct('resourceId', {
        tenantId: from,
        resourceId: { $in: [...agents, ...groups, ...servers, ...skills].map((doc) => doc._id) },
        $nor: [{ principalType: 'user', principalId: oid }],
      }),
      model('Prompt').distinct('groupId', {
        author: oid,
        tenantId: from,
        groupId: { $nin: ownGroupIds },
      }),
    ]),
  );
  const shared = new Set(sharedIds.map(String));
  const isShared = (doc: { _id: Types.ObjectId }) => shared.has(String(doc._id));
  const keptAgents = agents.filter(isShared);
  const keptFiles = keptAgents.flatMap((agent) =>
    Object.values(agent.tool_resources ?? {}).flatMap((resource) => resource?.file_ids ?? []),
  );
  return {
    keptAgents: keptAgents.map((agent) => String(agent._id)),
    keptPromptGroups: [
      ...groups.filter(isShared).map((group) => String(group._id)),
      ...foreignGroups.filter((id) => id != null).map(String),
    ],
    keptMcpServers: servers.filter(isShared).map((server) => String(server._id)),
    keptSkills: skills.filter(isShared).map((skill) => String(skill._id)),
    keptFiles: [...new Set(keptFiles)],
    movedAgentIds: agents
      .filter((agent) => !isShared(agent))
      .flatMap((agent) => (agent.id ? [agent.id] : [])),
    movedSkills: skills.filter((skill) => !isShared(skill)).map((skill) => String(skill._id)),
  };
}

type ToolResources = Record<string, { file_ids?: string[] } | null | undefined>;

/**
 * Builds the job that moves a person, with their data, between tenants. One move per user runs
 * at a time (a unique running record is the lock, its lease lets a later trigger resume after a
 * crash). With transactions every record and the user change together; without, each step is
 * recorded as it completes and a retry carries on from there. The user's own tenant changes last,
 * and a final sweep picks up anything written in the old tenant while the move ran.
 */
export function createMemberMover(deps: MoverDeps): MemberMover {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const now = deps.now ?? (() => new Date());
  let transactionSupport: Promise<boolean> | null = null;
  const transactions =
    deps.transactions ?? (() => (transactionSupport ??= supportsTransactions(mongoose)));

  const leaseUntil = () => new Date(now().getTime() + leaseMs);

  async function hasDuplicateAccount(user: IUser, to: string | null): Promise<boolean> {
    const same: Filter[] = [];
    if (user.email) {
      same.push({ email: user.email });
    }
    if (user.openidId) {
      same.push({ openidId: user.openidId, openidIssuer: user.openidIssuer });
    }
    if (same.length === 0) {
      return false;
    }
    const clash = await users().collection.findOne(
      { _id: { $ne: user._id }, tenantId: to, $or: same },
      { projection: { _id: 1 } },
    );
    return clash != null;
  }

  /** Updates the record only while this trigger still holds it, and extends the lease. */
  async function checkpoint(
    record: IMemberMove & { _id: Types.ObjectId },
    update: UpdateQuery<IMemberMove>,
  ): Promise<void> {
    const result = await moves()
      .updateOne(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        { ...update, $set: { ...(update.$set ?? {}), leaseUntil: leaseUntil() } },
      )
      .exec();
    if (result.matchedCount !== 1) {
      throw new LeaseLost();
    }
  }

  type Held = IMemberMove & { _id: Types.ObjectId };
  type Acquired = { status: 'acquired'; record: Held } | { status: 'done'; outcome: MoveOutcome };

  async function claim(existing: Held): Promise<Acquired> {
    const leaseId = randomUUID();
    const claimed = await moves()
      .findOneAndUpdate(
        {
          _id: existing._id,
          status: 'running',
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now() } }],
        },
        { $set: { leaseId, leaseUntil: leaseUntil() } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    return claimed
      ? { status: 'acquired', record: claimed }
      : { status: 'done', outcome: { status: 'busy' } };
  }

  async function acquire(request: MoveRequest): Promise<Acquired> {
    const running = await moves()
      .findOne({ userId: request.userId, status: 'running' })
      .lean<Held>()
      .exec();
    if (running) {
      return claim(running);
    }
    const refused = (reason: MoveRefusal): Acquired => ({
      status: 'done',
      outcome: { status: 'refused', reason },
    });
    const user = await runAsSystem(() => users().findById(request.userId).lean<IUser>().exec());
    if (!user) {
      return refused('not_found');
    }
    if (await isPlatformStaff(String(user._id), user.role, user.email)) {
      return refused('staff');
    }
    const current = user.tenantId || null;
    if (request.from === request.to || current === request.to) {
      return { status: 'done', outcome: { status: 'noop' } };
    }
    if (current !== request.from) {
      return refused('stale');
    }
    if (await hasDuplicateAccount(user, request.to)) {
      return refused('duplicate_account');
    }
    try {
      const created = await moves().create({
        userId: user._id,
        from: request.from,
        to: request.to,
        reason: request.reason,
        status: 'running',
        leaseId: randomUUID(),
        leaseUntil: leaseUntil(),
        wasActive: request.from != null && isActiveMember(user),
      });
      return { status: 'acquired', record: created.toObject() as Held };
    } catch (error) {
      if (isDuplicate(error)) {
        return { status: 'done', outcome: { status: 'busy' } };
      }
      throw error;
    }
  }

  function contextFor(record: Held, user: IUser, plan: MemberMovePlan): StepContext {
    const userId = String(record.userId);
    return {
      userId,
      oid: new Types.ObjectId(userId),
      from: record.from ?? null,
      to: record.to ?? null,
      plan,
      memberKeys: [userId, ...(user.idOnTheSource ? [String(user.idOnTheSource)] : [])],
    };
  }

  function stepsFor(record: Held): ReadonlyArray<Step> {
    return record.from == null ? STEPS.filter((step) => !step.leaveOnly) : STEPS;
  }

  async function switchUser(ctx: StepContext, user: IUser, session?: ClientSession) {
    const reset = { suspendedAt: '', suspendedBy: '', removedAt: '', removedBy: '' };
    const role = user.role === INSTITUTION_ADMIN_ROLE ? SystemRoles.USER : user.role;
    const update: mongo.UpdateFilter<mongo.Document> = ctx.to
      ? {
          $set: {
            tenantId: ctx.to,
            accountScope: 'institution',
            membershipStatus: InstitutionMembershipStatuses.ACTIVE,
            ...(role ? { role } : null),
          },
          $unset: { ...reset, bdrenNotedOrganizationId: '' },
        }
      : {
          $set: { accountScope: 'standalone', ...(role ? { role } : null) },
          $unset: { ...reset, tenantId: '', membershipStatus: '', bdrenNotedOrganizationId: '' },
        };
    await users().collection.updateOne({ _id: ctx.oid, tenantId: ctx.from }, update, { session });
  }

  async function inTransaction(record: Held, ctx: StepContext, user: IUser): Promise<void> {
    const session = await mongoose.startSession();
    try {
      let moved: Record<string, number> = {};
      await session.withTransaction(async () => {
        moved = {};
        const scoped = { ...ctx, session };
        for (const step of stepsFor(record)) {
          moved[step.name] = (await runStep(step, scoped)).moved;
        }
        await switchUser(scoped, user, session);
      });
      await checkpoint(record, {
        $set: {
          mode: 'transaction',
          completed: stepsFor(record).map((step) => step.name),
          moved,
          userSwitched: true,
        },
      });
    } finally {
      await session.endSession();
    }
  }

  async function sequential(record: Held, ctx: StepContext, user: IUser): Promise<void> {
    if (record.mode !== 'sequential') {
      await checkpoint(record, { $set: { mode: 'sequential' } });
    }
    const done = new Set(record.completed ?? []);
    for (const step of stepsFor(record)) {
      if (done.has(step.name)) {
        continue;
      }
      const result = await runStep(step, ctx);
      await checkpoint(record, {
        $push: { completed: step.name },
        $inc: {
          [`moved.${step.name}`]: result.moved,
          [`conflicts.${step.name}`]: result.conflicts,
        },
      });
    }
    await switchUser(ctx, user);
    await checkpoint(record, { $set: { userSwitched: true } });
  }

  /**
   * Anything written in the old tenant while the move ran, caught after the user changed tenant.
   * What still clashes now is the final count of records left behind.
   */
  async function sweep(record: Held, ctx: StepContext): Promise<void> {
    const inc: Record<string, number> = {};
    const conflicts: Record<string, number> = {};
    for (const step of stepsFor(record)) {
      const result = await runStep(step, ctx);
      if (result.moved > 0) {
        inc[`moved.${step.name}`] = result.moved;
      }
      if (result.conflicts > 0) {
        conflicts[step.name] = result.conflicts;
      }
    }
    await checkpoint(record, { $inc: inc, $set: { conflicts } });
  }

  async function settleSeats(record: Held): Promise<void> {
    const userId = String(record.userId);
    if (record.from) {
      if (record.wasActive && !record.seatReleased) {
        try {
          await deps.releaseSeat(record.from);
        } catch (error) {
          logger.error(`[bdren] releasing ${userId}'s seat in ${record.from} failed`, error);
        }
        await checkpoint(record, { $set: { seatReleased: true } });
      }
      await deps.syncMember({ tenantId: record.from, userId });
    }
    if (record.to) {
      await deps.syncMember({ tenantId: record.to, userId });
    }
  }

  async function finish(record: Held): Promise<MoveOutcome> {
    const finished = await moves()
      .findOneAndUpdate(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        { $set: { status: 'done', finishedAt: now(), leaseId: null, leaseUntil: null } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!finished) {
      throw new LeaseLost();
    }
    const moved = finished.moved ?? {};
    const conflicts = finished.conflicts ?? {};
    const plan = finished.plan;
    try {
      await deps.recordAuditEntry({
        action: 'member.moved',
        actor: SERVICE_ACTOR,
        target: { type: 'user', id: String(record.userId) },
        metadata: {
          from: record.from ?? null,
          to: record.to ?? null,
          reason: record.reason,
          mode: finished.mode ?? null,
          ...prefixed('moved_', moved),
          ...prefixed('conflicts_', conflicts),
          keptOwner: String(record.userId),
          keptAgents: plan?.keptAgents.join(',') ?? '',
          keptPromptGroups: plan?.keptPromptGroups.join(',') ?? '',
          keptMcpServers: plan?.keptMcpServers.join(',') ?? '',
          keptSkills: plan?.keptSkills.join(',') ?? '',
          keptFiles: plan?.keptFiles.join(',') ?? '',
        },
        tenantId: undefined,
      });
    } catch (error) {
      logger.error('[bdren] recording the member move failed', error);
    }
    const user = await runAsSystem(() =>
      users().findById(record.userId).lean<MemberRecord>().exec(),
    );
    logger.info(
      `[bdren] moved user ${String(record.userId)} from ${record.from ?? 'no tenant'} to ${record.to ?? 'no tenant'} (${record.reason})`,
    );
    return {
      status: 'moved',
      user: user ?? {},
      from: record.from ?? null,
      to: record.to ?? null,
      moved,
      conflicts,
    };
  }

  async function refuse(record: Held, reason: MoveRefusal): Promise<MoveOutcome> {
    await moves()
      .updateOne(
        { _id: record._id, leaseId: record.leaseId },
        { $set: { status: 'refused', refusal: reason, leaseId: null, leaseUntil: null } },
      )
      .exec();
    return { status: 'refused', reason };
  }

  async function drive(held: Held): Promise<MoveOutcome> {
    let record = held;
    const reload = async () => {
      const fresh = await moves().findById(record._id).lean<Held>().exec();
      if (!fresh || fresh.leaseId !== record.leaseId) {
        throw new LeaseLost();
      }
      record = fresh;
    };
    if (record.to && !record.seatReserved) {
      if (!(await deps.reserveSeat(record.to))) {
        return refuse(record, 'full');
      }
      await checkpoint(record, { $set: { seatReserved: true } });
    }
    if (!record.plan) {
      await checkpoint(record, {
        $set: { plan: await makePlan(String(record.userId), record.from ?? null) },
      });
    }
    await reload();
    const user = await runAsSystem(() => users().findById(record.userId).lean<IUser>().exec());
    if (!user) {
      return refuse(record, 'not_found');
    }
    const ctx = contextFor(record, user, record.plan as MemberMovePlan);
    const switched = record.userSwitched || (user.tenantId || null) === (record.to ?? null);
    if (!switched) {
      const useTransaction = record.mode !== 'sequential' && (await transactions());
      if (useTransaction) {
        try {
          await runAsSystem(() => inTransaction(record, ctx, user));
        } catch (error) {
          if (error instanceof LeaseLost) {
            throw error;
          }
          logger.warn(
            `[bdren] moving ${ctx.userId} in a transaction failed; continuing step by step`,
            error,
          );
          await runAsSystem(() => sequential(record, ctx, user));
        }
      } else {
        await runAsSystem(() => sequential(record, ctx, user));
      }
      await reload();
    }
    await settleSeats(record);
    await runAsSystem(() => sweep(record, ctx));
    return finish(record);
  }

  return async function moveMember(request) {
    const acquired = await acquire({ ...request, userId: String(request.userId) });
    if (acquired.status === 'done') {
      return acquired.outcome;
    }
    const { record } = acquired;
    try {
      return await drive(record);
    } catch (error) {
      await moves()
        .updateOne(
          { _id: record._id, leaseId: record.leaseId, status: 'running' },
          { $set: { leaseUntil: now() } },
        )
        .exec()
        .catch(() => undefined);
      throw error;
    }
  };
}
