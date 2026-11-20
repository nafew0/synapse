import { randomUUID } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { Constants, SystemRoles, normalizeServerName } from 'librechat-data-provider';
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
  MemberMoveRename,
  MemberMoveStripped,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { ClientSession, Model, UpdateQuery, mongo } from 'mongoose';
import type { MemberRecord } from './place';
import type { SeatRelease } from './seats';
import { forgetMoveSeats } from './seats';
import { syncAlerts } from '~/admin/alerts/store';

type Filter = mongo.Filter<mongo.Document>;
type Pipeline = mongo.Document[];

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
  /** Someone else changed the person's tenant mid-move; their data followed them there instead. */
  | { status: 'redirected'; to: string | null }
  /** It kept failing; a superadmin was alerted and the account is no longer fenced. */
  | { status: 'failed' }
  | { status: 'refused'; reason: MoveRefusal };

export interface MoverDeps {
  /** Takes a seat for this move (idempotent per `moveId`); `false` when the institution is full. */
  reserveSeat: (tenantId: string, moveId: string) => Promise<boolean>;
  /**
   * Gives this move's seat back (idempotent per `moveId`). `drift` when the counter was already at
   * zero. Throws when it could not, so the move retries it later.
   */
  releaseSeat: (tenantId: string, moveId: string) => Promise<SeatRelease | void>;
  /** Brings the tenant's agent audience in line with the member's current state. */
  syncMember: (args: { tenantId: string; userId: string }) => Promise<unknown>;
  /** Drops cached config overrides of a tenant (`undefined`: no tenant). */
  clearOverrides?: (tenantId?: string) => Promise<unknown>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
  /** How long one trigger may hold a move before another may resume it. */
  leaseMs?: number;
  /** When to sweep again for writes of requests that were in flight (longest stream timeout). */
  lateSweepMs?: number;
  /** Above this many conversations, messages and files the move skips the transaction. */
  transactionDocLimit?: number;
  /** A transaction still running after this long is abandoned for the step-by-step path. */
  transactionTimeoutMs?: number;
  /** Runs `task` after `ms`; defaults to an unref'd timer. */
  schedule?: (task: () => void, ms: number) => void;
  now?: () => Date;
  /** Whether the deployment runs transactions; probed once from the connection by default. */
  transactions?: () => Promise<boolean>;
  /** After this many attempts, or this age, a move that keeps failing is marked failed. */
  maxAttempts?: number;
  maxAgeMs?: number;
  /** Tells a superadmin a move needs a person (the platform alerts). */
  alert?: (finding: { key: string; title: string; detail: string }) => Promise<unknown>;
}

export interface MemberMover {
  move: (request: MoveRequest) => Promise<MoveOutcome>;
  /** Finishes the user's unfinished move, if there is one; `null` when there is none. */
  resume: (userId: string) => Promise<MoveOutcome | null>;
  /** Finishes every unfinished move whose lease ran out and runs every late sweep that is due. */
  resumeStranded: () => Promise<{ resumed: number; swept: number }>;
  /** Runs one finished move's late sweep now, if it is due; whether it ran. */
  sweepLate: (moveId: string) => Promise<boolean>;
}

interface StepContext {
  userId: string;
  oid: Types.ObjectId;
  from: string | null;
  to: string | null;
  plan: MemberMovePlan;
  memberKeys: string[];
  /** Whether this source is an institution the person is leaving (kept items, heir, clean-up). */
  leave: boolean;
  session?: ClientSession;
  /** Keeps the lease (and the account fence) alive inside a long step. */
  heartbeat?: () => Promise<void>;
}

type StepKind =
  | 'retenant'
  | 'files'
  | 'agents'
  | 'skillFiles'
  | 'rename'
  | 'strip'
  | 'dropForeign'
  | 'transfer'
  | 'inherit'
  | 'revoke'
  | 'unenrol'
  | 'configs';

interface Step {
  name: string;
  model: string;
  kind?: StepKind;
  /** The field naming the person; absent when `where` alone selects the records. */
  owner?: string;
  where?: (ctx: StepContext) => Filter | Promise<Filter>;
  /** Fields that identify the same record in the target, so a clash is merged, not stranded. */
  mergeOn?: string[];
  /** Only when leaving an institution. */
  leaveOnly?: boolean;
}

interface StepResult {
  moved: number;
  conflicts: number;
  dropped?: string[];
  stripped?: MemberMoveStripped[];
}

const DUPLICATE_KEY = 11000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_LATE_SWEEP_MS = 10 * 60_000;
const DEFAULT_TRANSACTION_DOC_LIMIT = 5_000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000;
const MAX_SKILL_NAME = 64;
const MAX_DROPPED_LISTED = 200;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;
const HEARTBEAT_EVERY = 100;
const SERVICE_ACTOR = { type: 'service', name: 'bdren.ai' } as const;
export const PLATFORM_ROLES: ReadonlySet<string> = new Set<string>([
  SystemRoles.ADMIN,
  'PLATFORM_SUPERADMIN',
]);
/** Every resource kind the ACL can share, with the field naming its owner. */
const SHAREABLE: ReadonlyArray<readonly [string, string]> = [
  ['Agent', 'author'],
  ['PromptGroup', 'author'],
  ['MCPServer', 'author'],
  ['Skill', 'author'],
  ['SharedLink', 'user'],
];
/** Principals that only mean something inside one tenant. */
const SCOPED_PRINCIPALS = ['user', 'group', 'role'];

const toIds = (ids: string[]): Types.ObjectId[] => ids.map((id) => new Types.ObjectId(id));
/** Only what the person authored and shared: never a colleague's group they merely wrote prompts in. */
const keptResources = (plan: MemberMovePlan): Types.ObjectId[] =>
  toIds([...plan.keptAgents, ...plan.keptPromptGroups, ...plan.keptMcpServers, ...plan.keptSkills]);
const promptGroupsThatStay = (plan: MemberMovePlan): Types.ObjectId[] =>
  toIds([...plan.keptPromptGroups, ...(plan.foreignPromptGroups ?? [])]);
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mcpSuffix = (server: string) => `${Constants.mcp_delimiter}${server}`;

/** Transfers what stays to the heir, remembering who owned it. */
const transfer = (
  name: string,
  modelName: string,
  owner: string,
  where: (plan: MemberMovePlan) => Filter,
): Step => ({
  name,
  model: modelName,
  owner,
  kind: 'transfer',
  leaveOnly: true,
  where: ({ plan }) => where(plan),
});

/**
 * Collections holding a person's own work, in the order they move. Renames come first; the ACL
 * steps come after the resources they protect; on a leave, what stays is then handed to the heir,
 * and the person's remaining access, group memberships and per-user settings in the old
 * institution are removed last.
 */
const STEPS: ReadonlyArray<Step> = [
  { name: 'renames', model: 'MCPServer', kind: 'rename' },
  { name: 'strippedServers', model: 'Agent', kind: 'strip' },
  {
    name: 'conversations',
    model: 'Conversation',
    owner: 'user',
    mergeOn: ['conversationId', 'user'],
  },
  { name: 'messages', model: 'Message', owner: 'user', mergeOn: ['messageId', 'user'] },
  { name: 'toolCalls', model: 'ToolCall', owner: 'user' },
  { name: 'sharedLinks', model: 'SharedLink', owner: 'user' },
  { name: 'conversationTags', model: 'ConversationTag', owner: 'user', mergeOn: ['tag', 'user'] },
  { name: 'chatProjects', model: 'ChatProject', owner: 'user' },
  { name: 'presets', model: 'Preset', owner: 'user', mergeOn: ['presetId'] },
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
    kind: 'agents',
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
    where: ({ plan }) => ({ groupId: { $nin: promptGroupsThatStay(plan) } }),
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
  { name: 'skillFiles', model: 'SkillFile', kind: 'skillFiles' },
  { name: 'keys', model: 'Key', owner: 'userId' },
  { name: 'pluginAuths', model: 'PluginAuth', owner: 'userId' },
  { name: 'toolFavorites', model: 'ToolFavorite', owner: 'user' },
  { name: 'sessions', model: 'Session', owner: 'user' },
  { name: 'tokens', model: 'Token', owner: 'userId' },
  { name: 'balances', model: 'Balance', owner: 'user' },
  { name: 'aclDropped', model: 'AclEntry', kind: 'dropForeign' },
  {
    name: 'aclEntries',
    model: 'AclEntry',
    where: async (ctx) => ({ resourceId: { $in: await movedResources(ctx) } }),
  },
  transfer('keptAgents', 'Agent', 'author', (plan) => ({ _id: { $in: toIds(plan.keptAgents) } })),
  transfer('keptPromptGroups', 'PromptGroup', 'author', (plan) => ({
    _id: { $in: toIds(plan.keptPromptGroups) },
  })),
  transfer('keptPrompts', 'Prompt', 'author', () => ({})),
  transfer('keptMcpServers', 'MCPServer', 'author', (plan) => ({
    _id: { $in: toIds(plan.keptMcpServers) },
  })),
  transfer('keptSkills', 'Skill', 'author', (plan) => ({ _id: { $in: toIds(plan.keptSkills) } })),
  transfer('keptSkillFiles', 'SkillFile', 'author', (plan) => ({
    skillId: { $in: toIds(plan.keptSkills) },
  })),
  transfer('keptActions', 'Action', 'user', () => ({})),
  transfer('keptFiles', 'File', 'user', (plan) => ({ file_id: { $in: plan.keptFiles } })),
  { name: 'aclInherited', model: 'AclEntry', kind: 'inherit', leaveOnly: true },
  { name: 'aclRevoked', model: 'AclEntry', kind: 'revoke', leaveOnly: true },
  { name: 'groups', model: 'Group', kind: 'unenrol', leaveOnly: true },
  { name: 'configs', model: 'Config', kind: 'configs', leaveOnly: true },
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

/** The person's shareable resources in a tenant. */
async function ownedResources(
  ctx: StepContext,
  tenantId: string | null,
): Promise<Types.ObjectId[]> {
  const found = await Promise.all(
    SHAREABLE.map(([name, field]) =>
      model(name)
        .collection.find(
          { [field]: ownerValue(name, field, ctx), tenantId },
          { projection: { _id: 1 }, session: ctx.session },
        )
        .toArray(),
    ),
  );
  return found.flat().map((doc) => doc._id as Types.ObjectId);
}

/** Shareable resources of the person that are now in the target tenant: the ones that moved. */
const movedResources = (ctx: StepContext) => ownedResources(ctx, ctx.to);

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

const isMissing = (field: string) => ({ $eq: [{ $type: `$${field}` }, 'missing'] });
const setTenant = (to: string | null): mongo.Document =>
  to ? { $set: { tenantId: to } } : { $unset: 'tenantId' };

/** Stored objects keep their keys, which may name the old tenant: the first move records it. */
const keepStorageTenant = (from: string | null): mongo.Document => ({
  $set: {
    storageTenantId: {
      $cond: [isMissing('storageTenantId'), { $literal: from }, '$storageTenantId'],
    },
  },
});

function updateFor(step: Step, ctx: StepContext): mongo.UpdateFilter<mongo.Document> | Pipeline {
  if (step.kind === 'files' || step.kind === 'skillFiles') {
    return [keepStorageTenant(ctx.from), setTenant(ctx.to)];
  }
  if (step.kind === 'agents') {
    return [
      {
        $set: {
          avatar: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: '$avatar' }, 'object'] },
                  isMissing('avatar.storageTenantId'),
                ],
              },
              { $mergeObjects: ['$avatar', { storageTenantId: { $literal: ctx.from } }] },
              '$avatar',
            ],
          },
        },
      },
      setTenant(ctx.to),
    ];
  }
  if (step.kind === 'transfer') {
    const owner = step.owner as string;
    const storage = step.model === 'File' || step.model === 'SkillFile';
    return [
      {
        $set: {
          [owner]: new Types.ObjectId(ctx.plan.heir as string),
          transferredFrom: { $ifNull: ['$transferredFrom', `$${owner}`] },
          ...(storage
            ? {
                storageUserId: {
                  $cond: [isMissing('storageUserId'), { $toString: `$${owner}` }, '$storageUserId'],
                },
              }
            : null),
        },
      },
    ];
  }
  return ctx.to ? { $set: { tenantId: ctx.to } } : { $unset: { tenantId: '' } };
}

async function stepFilter(step: Step, ctx: StepContext): Promise<Filter> {
  const filter: Filter = { tenantId: ctx.from };
  if (step.owner) {
    filter[step.owner] = ownerValue(step.model, step.owner, ctx);
  }
  return step.where ? { ...filter, ...(await step.where(ctx)) } : filter;
}

/** Rewrites a tool key ending in `_mcp_<from>`: to `_mcp_<to>`, or (no `to`) marks it for removal. */
const toolKeyEndsWith = (input: string, server: string) => ({
  $regexMatch: { input, regex: `${escapeRegex(mcpSuffix(server))}$` },
});
const swapSuffix = (input: string, from: string, to: string) => ({
  $concat: [
    { $substrCP: [input, 0, { $subtract: [{ $strLenCP: input }, mcpSuffix(from).length] }] },
    mcpSuffix(to),
  ],
});

/**
 * Applies the renames the plan made for names already taken in the target. A renamed MCP server
 * takes along everything of the person's keyed by its name: the moving agents' server names, tool
 * keys and tool options, the stored credentials (`mcp_<name>`) and OAuth tokens (`mcp:<name>…`).
 * It runs first, before those rows move.
 */
async function applyRenames(ctx: StepContext): Promise<StepResult> {
  let moved = 0;
  for (const rename of ctx.plan.renames ?? []) {
    const isServer = rename.model === 'MCPServer';
    const field = isServer ? 'serverName' : 'name';
    const result = await model(rename.model).collection.updateOne(
      { _id: new Types.ObjectId(rename.id), tenantId: ctx.from, [field]: rename.from },
      {
        $set: {
          [field]: rename.to,
          ...(isServer ? { normalizedServerName: normalizeServerName(rename.to) } : null),
        },
      },
      { session: ctx.session },
    );
    moved += result.modifiedCount;
    if (isServer) {
      await renameServerInAgents(ctx, rename);
      await renameServerCredentials(ctx, rename);
    }
  }
  return { moved, conflicts: 0 };
}

async function renameServerInAgents(ctx: StepContext, rename: MemberMoveRename): Promise<void> {
  await model('Agent').collection.updateMany(
    {
      author: ctx.oid,
      tenantId: ctx.from,
      _id: { $nin: toIds(ctx.plan.keptAgents) },
      mcpServerNames: rename.from,
    },
    [
      {
        $set: {
          mcpServerNames: {
            $map: {
              input: '$mcpServerNames',
              as: 'name',
              in: { $cond: [{ $eq: ['$$name', rename.from] }, rename.to, '$$name'] },
            },
          },
          tools: {
            $map: {
              input: { $ifNull: ['$tools', []] },
              as: 'tool',
              in: {
                $cond: [
                  toolKeyEndsWith('$$tool', rename.from),
                  swapSuffix('$$tool', rename.from, rename.to),
                  '$$tool',
                ],
              },
            },
          },
          tool_options: {
            $arrayToObject: {
              $map: {
                input: { $objectToArray: { $ifNull: ['$tool_options', {}] } },
                as: 'option',
                in: {
                  k: {
                    $cond: [
                      toolKeyEndsWith('$$option.k', rename.from),
                      swapSuffix('$$option.k', rename.from, rename.to),
                      '$$option.k',
                    ],
                  },
                  v: '$$option.v',
                },
              },
            },
          },
        },
      },
    ],
    { session: ctx.session },
  );
}

async function renameServerCredentials(ctx: StepContext, rename: MemberMoveRename): Promise<void> {
  const fromKey = `${Constants.mcp_prefix}${rename.from}`;
  const toKey = `${Constants.mcp_prefix}${rename.to}`;
  await model('PluginAuth').collection.updateMany(
    {
      userId: ownerValue('PluginAuth', 'userId', ctx),
      tenantId: ctx.from,
      pluginKey: fromKey,
    },
    { $set: { pluginKey: toKey } },
    { session: ctx.session },
  );
  const fromId = `mcp:${rename.from}`;
  await model('Token').collection.updateMany(
    {
      userId: ownerValue('Token', 'userId', ctx),
      tenantId: ctx.from,
      identifier: { $regex: `^${escapeRegex(fromId)}(:|$)` },
    },
    [
      {
        $set: {
          identifier: {
            $concat: [
              `mcp:${rename.to}`,
              { $substrCP: ['$identifier', fromId.length, { $strLenCP: '$identifier' }] },
            ],
          },
        },
      },
    ],
    { session: ctx.session },
  );
}

/**
 * Moving agents that name an MCP server staying behind would, in the target, reach whatever server
 * has that name there. The name, its tool keys and its tool options are removed (and audited).
 */
async function stripServers(ctx: StepContext): Promise<StepResult> {
  let moved = 0;
  const stripped: MemberMoveStripped[] = [];
  for (const { agent, name } of ctx.plan.strippedServers ?? []) {
    const before = await model('Agent').collection.findOneAndUpdate(
      { _id: new Types.ObjectId(agent), tenantId: ctx.from, mcpServerNames: name },
      [
        {
          $set: {
            mcpServerNames: {
              $filter: { input: '$mcpServerNames', as: 'n', cond: { $ne: ['$$n', name] } },
            },
            tools: {
              $filter: {
                input: { $ifNull: ['$tools', []] },
                as: 'tool',
                cond: { $not: [toolKeyEndsWith('$$tool', name)] },
              },
            },
            tool_options: {
              $arrayToObject: {
                $filter: {
                  input: { $objectToArray: { $ifNull: ['$tool_options', {}] } },
                  as: 'option',
                  cond: { $not: [toolKeyEndsWith('$$option.k', name)] },
                },
              },
            },
          },
        },
      ],
      {
        session: ctx.session,
        returnDocument: 'before',
        projection: { tools: 1, tool_options: 1 },
      },
    );
    if (!before) {
      continue;
    }
    moved += 1;
    const suffix = mcpSuffix(name);
    const tools = ((before.tools as string[] | undefined) ?? []).filter((tool) =>
      tool.endsWith(suffix),
    );
    const options = Object.fromEntries(
      Object.entries((before.tool_options as mongo.Document | undefined) ?? {}).filter(([key]) =>
        key.endsWith(suffix),
      ),
    );
    stripped.push({ agent, name, tools, toolOptionsJson: JSON.stringify(options) });
  }
  return { moved, conflicts: 0, stripped };
}

/** Puts back what stripping took, when the move is undone and the agents return to the source. */
async function restoreStripped(details: MemberMoveStripped[]): Promise<number> {
  let restored = 0;
  for (const detail of details) {
    const options = Object.entries(
      JSON.parse(detail.toolOptionsJson || '{}') as mongo.Document,
    ).map(([k, v]) => ({ k, v }));
    const result = await model('Agent').collection.updateOne(
      { _id: new Types.ObjectId(detail.agent) },
      [
        {
          $set: {
            mcpServerNames: {
              $setUnion: [{ $ifNull: ['$mcpServerNames', []] }, { $literal: [detail.name] }],
            },
            tools: { $setUnion: [{ $ifNull: ['$tools', []] }, { $literal: detail.tools }] },
            tool_options: {
              $mergeObjects: [
                { $ifNull: ['$tool_options', {}] },
                { $arrayToObject: { $literal: options } },
              ],
            },
          },
        },
      ],
    );
    restored += result.modifiedCount;
  }
  return restored;
}

/**
 * Grants on the moved items to users, groups or roles that are not in the target tenant would
 * stay effective from there (an individual's grant to another individual, say): they are dropped.
 * Public grants keep a public link public; the person's own entry moves.
 */
async function dropForeignGrants(ctx: StepContext): Promise<StepResult> {
  const collection = model('AclEntry').collection;
  const entries = await collection
    .find(
      {
        tenantId: ctx.from,
        resourceId: { $in: await movedResources(ctx) },
        principalType: { $in: SCOPED_PRINCIPALS },
        $nor: [{ principalType: 'user', principalId: ctx.oid }],
      },
      { session: ctx.session },
    )
    .toArray();
  if (entries.length === 0) {
    return { moved: 0, conflicts: 0 };
  }
  const idsOf = (type: string) =>
    entries.filter((entry) => entry.principalType === type).map((entry) => entry.principalId);
  const [localUsers, localGroups] = await Promise.all([
    users().collection.distinct(
      '_id',
      { _id: { $in: idsOf('user') }, tenantId: ctx.to },
      { session: ctx.session },
    ),
    model('Group').collection.distinct(
      '_id',
      { _id: { $in: idsOf('group') }, tenantId: ctx.to },
      { session: ctx.session },
    ),
  ]);
  const local = new Set([...localUsers, ...localGroups].map(String));
  const foreign = entries.filter(
    (entry) => entry.principalType === 'role' || !local.has(String(entry.principalId)),
  );
  if (foreign.length === 0) {
    return { moved: 0, conflicts: 0 };
  }
  const result = await collection.deleteMany(
    { _id: { $in: foreign.map((entry) => entry._id) } },
    { session: ctx.session },
  );
  return {
    moved: result.deletedCount,
    conflicts: 0,
    dropped: foreign.map(
      (entry) =>
        `${entry.resourceType}:${String(entry.resourceId)}:${entry.principalType}:${String(entry.principalId)}`,
    ),
  };
}

/** The heir gets the person's grants on what stays, so the institution can still manage it. */
async function inheritGrants(ctx: StepContext): Promise<StepResult> {
  if (!ctx.plan.heirIsUser || !ctx.plan.heir) {
    return { moved: 0, conflicts: 0 };
  }
  const collection = model('AclEntry').collection;
  const heir = new Types.ObjectId(ctx.plan.heir);
  const entries = await collection
    .find(
      {
        tenantId: ctx.from,
        principalType: 'user',
        principalId: ctx.oid,
        resourceId: { $in: keptResources(ctx.plan) },
      },
      { session: ctx.session },
    )
    .toArray();
  let moved = 0;
  for (const entry of entries) {
    const result = await collection.updateOne(
      {
        tenantId: ctx.from,
        principalType: 'user',
        principalId: heir,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
      },
      {
        $max: { permBits: entry.permBits ?? 1 },
        $setOnInsert: {
          principalModel: 'User',
          roleId: entry.roleId,
          grantedBy: ctx.oid,
          grantedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, session: ctx.session },
    );
    moved += result.upsertedCount + result.modifiedCount;
  }
  return { moved, conflicts: 0 };
}

/**
 * Applies one step. Inside a transaction a duplicate key aborts it (the caller falls back to the
 * sequential path); outside one a clash with the same record already in the target is merged
 * into it (the more recent write wins), and any other clash is left in place and counted.
 */
async function runStep(step: Step, ctx: StepContext): Promise<StepResult> {
  const collection = model(step.model).collection;
  const { session } = ctx;
  switch (step.kind) {
    case 'rename':
      return applyRenames(ctx);
    case 'strip':
      return stripServers(ctx);
    case 'dropForeign':
      return dropForeignGrants(ctx);
    case 'inherit':
      return inheritGrants(ctx);
    case 'revoke': {
      const stranded = await ownedResources(ctx, ctx.from);
      const result = await collection.deleteMany(
        {
          tenantId: ctx.from,
          principalType: 'user',
          principalId: ctx.oid,
          resourceId: { $nin: stranded },
        },
        { session },
      );
      return { moved: result.deletedCount, conflicts: 0 };
    }
    case 'unenrol': {
      const result = await model(step.model)
        .updateMany(
          { tenantId: ctx.from, memberIds: { $in: ctx.memberKeys } },
          { $pull: { memberIds: { $in: ctx.memberKeys } } },
          { session },
        )
        .exec();
      return { moved: result.modifiedCount, conflicts: 0 };
    }
    case 'configs': {
      const result = await collection.deleteMany(
        { tenantId: ctx.from, principalType: 'user', principalId: ctx.userId },
        { session },
      );
      return { moved: result.deletedCount, conflicts: 0 };
    }
    case 'transfer':
      if (!ctx.plan.heir) {
        return { moved: 0, conflicts: 0 };
      }
      break;
    default:
      break;
  }
  const filter =
    step.kind === 'skillFiles' ? await skillFileFilter(ctx) : await stepFilter(step, ctx);
  const update = updateFor(step, ctx);
  try {
    const result = await collection.updateMany(filter, update, { session });
    return { moved: result.modifiedCount, conflicts: 0 };
  } catch (error) {
    if (!isDuplicate(error) || session) {
      throw error;
    }
  }
  return oneByOne(step, ctx, filter, update);
}

/** Skill files move only with a skill that has moved. */
async function skillFileFilter(ctx: StepContext): Promise<Filter> {
  const moved = await model('Skill').collection.distinct(
    '_id',
    { _id: { $in: toIds(ctx.plan.movedSkills) }, author: ctx.oid, tenantId: ctx.to },
    { session: ctx.session },
  );
  return { tenantId: ctx.from, skillId: { $in: moved } };
}

async function oneByOne(
  step: Step,
  ctx: StepContext,
  filter: Filter,
  update: mongo.UpdateFilter<mongo.Document> | Pipeline,
): Promise<StepResult> {
  const collection = model(step.model).collection;
  const docs = await collection.find(filter).toArray();
  let moved = 0;
  let conflicts = 0;
  for (const [index, doc] of docs.entries()) {
    if (index > 0 && index % HEARTBEAT_EVERY === 0) {
      await ctx.heartbeat?.();
    }
    try {
      moved += (await collection.updateOne({ ...filter, _id: doc._id }, update)).modifiedCount;
    } catch (error) {
      if (!isDuplicate(error)) {
        throw error;
      }
      if (step.mergeOn && (await mergeInto(step, ctx, doc))) {
        moved += 1;
        continue;
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

/**
 * The same record already exists in the target: a request still running under the old tenant
 * wrote it again after it moved. The newer copy's fields win, and the old-tenant copy goes.
 */
async function mergeInto(step: Step, ctx: StepContext, ghost: mongo.Document): Promise<boolean> {
  const collection = model(step.model).collection;
  const key = Object.fromEntries((step.mergeOn ?? []).map((field) => [field, ghost[field]]));
  const target = await collection.findOne({ ...key, tenantId: ctx.to });
  if (!target) {
    return false;
  }
  const ghostTime = new Date(ghost.updatedAt ?? 0).getTime();
  const targetTime = new Date(target.updatedAt ?? 0).getTime();
  if (ghostTime >= targetTime) {
    const { _id, tenantId: _tenant, ...fields } = ghost;
    await collection.updateOne({ _id: target._id }, { $set: fields });
  }
  await collection.deleteOne({ _id: ghost._id });
  return true;
}

class LeaseLost extends Error {
  constructor() {
    super('member move lease lost');
    this.name = 'LeaseLost';
  }
}

/** The user's tenant changed under the move: someone else placed them. */
class SwitchMismatch extends Error {
  constructor() {
    super('the user is no longer in the tenant the move started from');
    this.name = 'SwitchMismatch';
  }
}

/** The target now holds another account of the person's; the move cannot finish there. */
class DuplicateAccount extends Error {
  constructor() {
    super('the target tenant already holds another account of this person');
    this.name = 'DuplicateAccount';
  }
}

class TransactionTooSlow extends Error {
  constructor() {
    super('member move transaction ran past its time limit');
    this.name = 'TransactionTooSlow';
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

type ToolResources = Record<string, { file_ids?: string[] } | null | undefined>;
type OwnedDoc = {
  _id: Types.ObjectId;
  id?: string;
  mcpServerNames?: string[];
  name?: string;
  serverName?: string;
  tool_resources?: ToolResources;
};

/** The person's `file_id`s that an agent staying in the tenant uses, whoever wrote the agent. */
async function filesUsedByStayingAgents(
  oid: Types.ObjectId,
  from: string,
  movingAgents: Types.ObjectId[],
): Promise<string[]> {
  const mine = await model('File').distinct('file_id', { user: oid, tenantId: from });
  if (mine.length === 0) {
    return [];
  }
  const rows = await model('Agent')
    .aggregate<{ ids: string[] }>([
      { $match: { tenantId: from, _id: { $nin: movingAgents } } },
      { $project: { resources: { $objectToArray: { $ifNull: ['$tool_resources', {}] } } } },
      { $unwind: '$resources' },
      { $unwind: '$resources.v.file_ids' },
      { $match: { 'resources.v.file_ids': { $in: mine } } },
      { $group: { _id: null, ids: { $addToSet: '$resources.v.file_ids' } } },
    ])
    .exec();
  return rows[0]?.ids ?? [];
}

/** Who owns what stays: the longest-standing active admin of the institution, else the institution itself. */
async function heirFor(
  oid: Types.ObjectId,
  from: string,
): Promise<{ heir: string | null; heirIsUser: boolean }> {
  const admin = await users()
    .findOne({
      _id: { $ne: oid },
      tenantId: from,
      role: INSTITUTION_ADMIN_ROLE,
      membershipStatus: { $in: [InstitutionMembershipStatuses.ACTIVE, null] },
    })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean<{ _id: Types.ObjectId }>()
    .exec();
  if (admin) {
    return { heir: String(admin._id), heirIsUser: true };
  }
  const institution = await model('Institution')
    .findOne({ tenantId: from })
    .select('_id')
    .lean<{ _id: Types.ObjectId }>()
    .exec();
  return { heir: institution ? String(institution._id) : null, heirIsUser: false };
}

function freeName(base: string, taken: Set<string>, limit = Infinity): string {
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? '-moved' : `-moved-${attempt}`;
    const name = `${base.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
    if (!taken.has(name) && !taken.has(normalizeServerName(name))) {
      return name;
    }
  }
}

/** Names of moving MCP servers and skills already taken in the target, renamed so everything moves. */
async function renamesFor(
  oid: Types.ObjectId,
  to: string | null,
  servers: OwnedDoc[],
  skills: OwnedDoc[],
  /** Names of servers staying in the source: a rename must not take one, or strip and rename collide. */
  reserved: Set<string> = new Set(),
): Promise<MemberMoveRename[]> {
  const renames: MemberMoveRename[] = [];
  if (servers.length > 0) {
    const existing = await model('MCPServer')
      .find({ tenantId: to })
      .select('serverName normalizedServerName')
      .lean<Array<{ serverName: string; normalizedServerName?: string }>>()
      .exec();
    const taken = new Set(
      existing.flatMap((server) => [server.serverName, server.normalizedServerName ?? '']),
    );
    for (const server of servers) {
      const name = server.serverName ?? '';
      if (!taken.has(name) && !taken.has(normalizeServerName(name))) {
        continue;
      }
      const renamed = freeName(name, new Set([...taken, ...reserved]));
      taken.add(renamed);
      taken.add(normalizeServerName(renamed));
      renames.push({ model: 'MCPServer', id: String(server._id), from: name, to: renamed });
    }
  }
  if (skills.length > 0) {
    const taken = new Set(
      (await model('Skill').distinct('name', { tenantId: to, author: oid })).map(String),
    );
    for (const skill of skills) {
      const name = skill.name ?? '';
      if (!taken.has(name)) {
        continue;
      }
      const renamed = freeName(name, taken, MAX_SKILL_NAME);
      taken.add(renamed);
      renames.push({ model: 'Skill', id: String(skill._id), from: name, to: renamed });
    }
  }
  return renames;
}

/** Names of MCP servers in a tenant, as stored and normalized. */
async function serverNamesIn(tenantId: string | null): Promise<Set<string>> {
  const servers = await model('MCPServer')
    .find({ tenantId })
    .select('serverName')
    .lean<Array<{ serverName: string }>>()
    .exec();
  return new Set(servers.map((server) => server.serverName));
}

/** Server names moving agents use that belong to a server staying in the source tenant. */
function strippedServersOf(
  agents: OwnedDoc[],
  staying: Set<string>,
): Array<{ agent: string; name: string }> {
  return agents.flatMap((agent) =>
    (agent.mcpServerNames ?? [])
      .filter((name) => staying.has(name))
      .map((name) => ({ agent: String(agent._id), name })),
  );
}

/**
 * Plans what stays behind and what is renamed or stripped. Only a leave (`leave`: the person was
 * a member of `from`) keeps anything: what they shared there, and their files any staying agent
 * uses; it is handed to the heir. Moving out of a tenant they never belonged to (a redirected join)
 * takes everything.
 */
async function makePlan(
  userId: string,
  from: string | null,
  to: string | null,
  leave: boolean = from != null,
): Promise<MemberMovePlan> {
  const oid = new Types.ObjectId(userId);
  const own = (name: string, select: string) =>
    model(name).find({ author: oid, tenantId: from }).select(select).lean<OwnedDoc[]>().exec();
  return runAsSystem(async () => {
    const [agents, groups, servers, skills, serverNames] = await Promise.all([
      own('Agent', '_id id tool_resources mcpServerNames'),
      own('PromptGroup', '_id'),
      own('MCPServer', '_id serverName'),
      own('Skill', '_id name'),
      serverNamesIn(from),
    ]);
    let shared = new Set<string>();
    let foreignGroups: string[] = [];
    if (leave) {
      const [sharedIds, foreign] = await Promise.all([
        model('AclEntry').distinct('resourceId', {
          tenantId: from,
          resourceId: { $in: [...agents, ...groups, ...servers, ...skills].map((doc) => doc._id) },
          $nor: [{ principalType: 'user', principalId: oid }],
        }),
        model('Prompt').distinct('groupId', {
          author: oid,
          tenantId: from,
          groupId: { $nin: groups.map((group) => group._id) },
        }),
      ]);
      shared = new Set(sharedIds.map(String));
      foreignGroups = foreign.filter((id) => id != null).map(String);
    }
    const isShared = (doc: OwnedDoc) => shared.has(String(doc._id));
    const moving = (docs: OwnedDoc[]) => docs.filter((doc) => !isShared(doc));
    const movingAgents = moving(agents);
    const movingServers = new Set(moving(servers).map((server) => server.serverName ?? ''));
    const staying = new Set([...serverNames].filter((name) => !movingServers.has(name)));
    const [keptFiles, renames, heir] = await Promise.all([
      leave && from != null
        ? filesUsedByStayingAgents(
            oid,
            from,
            movingAgents.map((agent) => agent._id),
          )
        : Promise.resolve([]),
      renamesFor(oid, to, moving(servers), moving(skills), staying),
      leave && from != null
        ? heirFor(oid, from)
        : Promise.resolve({ heir: null, heirIsUser: false }),
    ]);
    return {
      keptAgents: agents.filter(isShared).map((agent) => String(agent._id)),
      keptPromptGroups: groups.filter(isShared).map((group) => String(group._id)),
      foreignPromptGroups: foreignGroups,
      keptMcpServers: servers.filter(isShared).map((server) => String(server._id)),
      keptSkills: skills.filter(isShared).map((skill) => String(skill._id)),
      keptFiles,
      movedAgentIds: movingAgents.flatMap((agent) => (agent.id ? [agent.id] : [])),
      movedSkills: moving(skills).map((skill) => String(skill._id)),
      heir: heir.heir,
      heirIsUser: heir.heirIsUser,
      renames,
      strippedServers: strippedServersOf(movingAgents, staying),
    };
  });
}

/**
 * Builds the job that moves a person, with their data, between tenants. One move per user runs
 * at a time (a unique running record is the lock, its lease lets a later trigger resume after a
 * crash). With transactions every record and the user change together; without, each step is
 * recorded as it completes and a retry carries on from there. The user's own tenant changes last;
 * a sweep right after, and a late one once in-flight requests are done, pick up anything written
 * in the old tenant meanwhile. While it runs the account is fenced (`movingUntil`).
 */
export function createMemberMover(deps: MoverDeps): MemberMover {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const lateSweepMs = deps.lateSweepMs ?? DEFAULT_LATE_SWEEP_MS;
  const transactionDocLimit = deps.transactionDocLimit ?? DEFAULT_TRANSACTION_DOC_LIMIT;
  const transactionTimeoutMs = deps.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const schedule =
    deps.schedule ??
    ((task: () => void, ms: number) => {
      setTimeout(task, ms).unref?.();
    });
  let transactionSupport: Promise<boolean> | null = null;
  const transactions =
    deps.transactions ?? (() => (transactionSupport ??= supportsTransactions(mongoose)));

  const leaseUntil = () => new Date(now().getTime() + leaseMs);

  type Held = IMemberMove & { _id: Types.ObjectId };
  type Acquired = { status: 'acquired'; record: Held } | { status: 'done'; outcome: MoveOutcome };

  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const alert =
    deps.alert ??
    ((finding: { key: string; title: string; detail: string }) =>
      syncAlerts([{ ...finding, kind: 'member_move', severity: 'critical' }], []));
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  async function hasDuplicateAccount(
    user: IUser,
    to: string | null,
    session?: ClientSession,
  ): Promise<boolean> {
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
      { projection: { _id: 1 }, session },
    );
    return clash != null;
  }

  /** Requests are asked to retry until `until`; `null` lifts the fence. */
  const fence = (userId: Types.ObjectId | string, until: Date | null) =>
    users()
      .collection.updateOne(
        { _id: new Types.ObjectId(String(userId)) },
        until ? { $set: { movingUntil: until } } : { $unset: { movingUntil: '' } },
      )
      .then(() => undefined);

  /** Updates the record only while this trigger still holds it, and extends lease and fence. */
  async function checkpoint(record: Held, update: UpdateQuery<IMemberMove>): Promise<void> {
    const until = leaseUntil();
    const result = await moves()
      .updateOne(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        { ...update, $set: { ...(update.$set ?? {}), leaseUntil: until } },
      )
      .exec();
    if (result.matchedCount !== 1) {
      throw new LeaseLost();
    }
    await fence(record.userId, until);
  }

  const moveId = (record: Held) => String(record._id);
  const heartbeatMs = Math.max(1_000, Math.min(Math.floor(leaseMs / 3), 60_000));

  /** A move that is over no longer needs its seat operations remembered. */
  const forgetSeats = (record: Held) =>
    forgetMoveSeats([record.from, record.to], moveId(record)).catch((error) =>
      logger.warn(`[bdren] forgetting the seat operations of move ${moveId(record)} failed`, error),
    );

  /** Renews lease and fence on a timer while one (possibly long) step runs. */
  async function beating<T>(ctx: StepContext, task: () => Promise<T>): Promise<T> {
    if (!ctx.heartbeat) {
      return task();
    }
    const beat = ctx.heartbeat;
    const timer = setInterval(() => {
      beat().catch((error) => logger.warn('[bdren] member move heartbeat failed', error));
    }, heartbeatMs);
    timer.unref?.();
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  /** Confirms this trigger still holds the move right before the user changes tenant. */
  async function holdLease(record: Held, session?: ClientSession): Promise<void> {
    const result = await moves().collection.updateOne(
      { _id: record._id, leaseId: record.leaseId, status: 'running' },
      { $set: { leaseUntil: leaseUntil() } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new LeaseLost();
    }
  }

  /** Gives back the seat this move took in its target, unless the person got there. */
  async function returnSeat(record: Held): Promise<void> {
    if (record.to && record.seatReserved && !record.userSwitched) {
      await deps.releaseSeat(record.to, moveId(record));
    }
  }

  /**
   * A move that keeps failing (or is too old) stops: the fence is lifted, a seat it took and never
   * used is given back, and a superadmin is told, with what the record shows was done.
   */
  async function fail(record: Held, cause: string): Promise<MoveOutcome> {
    const failed = await moves()
      .findOneAndUpdate(
        { _id: record._id, status: 'running', leaseId: record.leaseId },
        { $set: { status: 'failed', refusal: cause, leaseId: null, leaseUntil: null } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!failed) {
      return { status: 'busy' };
    }
    await fence(record.userId, null);
    try {
      await returnSeat(failed);
    } catch (error) {
      logger.error(`[bdren] giving back the seat of failed move ${moveId(record)} failed`, error);
    }
    const detail = `Moving user ${String(record.userId)} from ${record.from ?? 'no institution'} to ${
      record.to ?? 'no institution'
    } stopped after ${failed.attempts ?? 0} attempts (${cause}). Steps done: ${
      (failed.completed ?? []).join(', ') || 'none'
    }; user switched: ${failed.userSwitched ? 'yes' : 'no'}. Finish or undo it by hand.`;
    logger.error(`[bdren] ${detail}`);
    try {
      await alert({
        key: `member_move:${moveId(record)}`,
        title: 'A member move needs attention',
        detail,
      });
    } catch (error) {
      logger.error('[bdren] raising the member move alert failed', error);
    }
    await audit(record, failed, { failed: cause });
    await forgetSeats(failed);
    return { status: 'failed' };
  }

  const exhausted = (record: Held) =>
    (record.attempts ?? 0) >= maxAttempts ||
    now().getTime() - new Date(record.createdAt ?? now()).getTime() > maxAgeMs;

  async function claim(existing: Held): Promise<Acquired> {
    const leaseId = randomUUID();
    const claimed = await moves()
      .findOneAndUpdate(
        {
          _id: existing._id,
          status: 'running',
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now() } }],
        },
        { $set: { leaseId, leaseUntil: leaseUntil() }, $inc: { attempts: 1 } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!claimed) {
      return { status: 'done', outcome: { status: 'busy' } };
    }
    if ((claimed.attempts ?? 0) > maxAttempts || exhausted({ ...claimed, attempts: 0 })) {
      return { status: 'done', outcome: await fail(claimed, 'too_many_attempts') };
    }
    return { status: 'acquired', record: claimed };
  }

  const findRunning = (userId: string) =>
    moves().findOne({ userId, status: 'running' }).lean<Held>().exec();

  async function acquire(request: MoveRequest): Promise<Acquired> {
    const running = await findRunning(request.userId);
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
        attempts: 1,
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

  function contextFor(
    record: Held,
    user: IUser,
    plan: MemberMovePlan,
    from = record.from ?? null,
    to = record.to ?? null,
    leave = from != null,
  ): StepContext {
    const userId = String(record.userId);
    return {
      userId,
      oid: new Types.ObjectId(userId),
      from,
      to,
      plan,
      leave,
      memberKeys: [userId, ...(user.idOnTheSource ? [String(user.idOnTheSource)] : [])],
    };
  }

  function stepsFor(ctx: StepContext): ReadonlyArray<Step> {
    return ctx.leave ? STEPS : STEPS.filter((step) => !step.leaveOnly);
  }

  /**
   * Changes the user's own tenant, and resolves to whether they were an active member just before
   * (read in the same write, so a suspension racing the move cannot double-count a seat); `null`
   * when they were already in the target. Throws `DuplicateAccount` when the target now holds
   * another account of theirs, `SwitchMismatch` when they are no longer in `from`.
   */
  async function switchUser(
    ctx: StepContext,
    user: IUser,
    session?: ClientSession,
  ): Promise<boolean | null> {
    if (await hasDuplicateAccount(user, ctx.to, session)) {
      throw new DuplicateAccount();
    }
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
    let previous: mongo.WithId<mongo.Document> | null;
    try {
      previous = await users().collection.findOneAndUpdate(
        { _id: ctx.oid, tenantId: ctx.from },
        update,
        { session, returnDocument: 'before', projection: { membershipStatus: 1 } },
      );
    } catch (error) {
      if (isDuplicate(error)) {
        throw new DuplicateAccount();
      }
      throw error;
    }
    if (previous) {
      return ctx.from != null && isActiveMember(previous as Pick<IUser, 'membershipStatus'>);
    }
    const current = await users().collection.findOne(
      { _id: ctx.oid },
      { projection: { tenantId: 1 }, session },
    );
    if ((current?.tenantId || null) !== ctx.to) {
      throw new SwitchMismatch();
    }
    return null;
  }

  const switchedFields = (wasActive: boolean | null) =>
    wasActive == null ? { userSwitched: true } : { userSwitched: true, wasActive };

  /** Conversations, messages and files to move: a cheap measure of how heavy the move is. */
  async function weight(ctx: StepContext): Promise<number> {
    const counts = await Promise.all(
      (
        [
          ['Conversation', 'user'],
          ['Message', 'user'],
          ['File', 'user'],
        ] as const
      ).map(([name, field]) =>
        model(name).collection.countDocuments({
          [field]: ownerValue(name, field, ctx),
          tenantId: ctx.from,
        }),
      ),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async function inTransaction(record: Held, ctx: StepContext, user: IUser): Promise<void> {
    const session = await mongoose.startSession();
    const deadline = Date.now() + transactionTimeoutMs;
    try {
      let moved: Record<string, number> = {};
      let dropped: string[] = [];
      let wasActive: boolean | null = null;
      let stripped: MemberMoveStripped[] = [];
      await session.withTransaction(async () => {
        moved = {};
        dropped = [];
        stripped = [];
        const scoped = { ...ctx, session };
        for (const step of stepsFor(ctx)) {
          if (Date.now() > deadline) {
            throw new TransactionTooSlow();
          }
          const result = await runStep(step, scoped);
          moved[step.name] = result.moved;
          dropped.push(...(result.dropped ?? []));
          stripped.push(...(result.stripped ?? []));
        }
        await holdLease(record, session);
        wasActive = await switchUser(scoped, user, session);
      });
      await checkpoint(record, {
        $set: {
          mode: 'transaction',
          completed: stepsFor(ctx).map((step) => step.name),
          moved,
          droppedGrants: dropped.slice(0, MAX_DROPPED_LISTED),
          strippedDetails: stripped,
          ...switchedFields(wasActive),
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
    const steady = { ...ctx, heartbeat: () => checkpoint(record, {}) };
    const done = new Set(record.completed ?? []);
    for (const step of stepsFor(ctx)) {
      if (done.has(step.name)) {
        continue;
      }
      const result = await beating(steady, () => runStep(step, steady));
      await checkpoint(record, {
        $push: {
          completed: step.name,
          ...(result.dropped?.length
            ? { droppedGrants: { $each: result.dropped, $slice: MAX_DROPPED_LISTED } }
            : null),
          ...(result.stripped?.length ? { strippedDetails: { $each: result.stripped } } : null),
        },
        $inc: { [`moved.${step.name}`]: result.moved },
      });
    }
    await holdLease(record);
    const wasActive = await switchUser(ctx, user);
    await checkpoint(record, { $set: switchedFields(wasActive) });
  }

  /** Runs every step again; returns what moved and what still clashes. */
  async function sweepSteps(ctx: StepContext) {
    const moved: Record<string, number> = {};
    const conflicts: Record<string, number> = {};
    const dropped: string[] = [];
    for (const step of stepsFor(ctx)) {
      const result = await beating(ctx, () => runStep(step, ctx));
      if (result.moved > 0) {
        moved[`moved.${step.name}`] = result.moved;
      }
      if (result.conflicts > 0) {
        conflicts[step.name] = result.conflicts;
      }
      dropped.push(...(result.dropped ?? []));
    }
    return { moved, conflicts, dropped };
  }

  /**
   * Anything written in the old tenant while the move ran, caught after the user changed tenant.
   * What still clashes now is the final count of records left behind.
   */
  async function sweep(record: Held, ctx: StepContext): Promise<void> {
    const { moved, conflicts, dropped } = await sweepSteps({
      ...ctx,
      heartbeat: () => checkpoint(record, {}),
    });
    await checkpoint(record, {
      $inc: moved,
      $set: { conflicts },
      ...(dropped.length
        ? { $push: { droppedGrants: { $each: dropped, $slice: MAX_DROPPED_LISTED } } }
        : null),
    });
  }

  async function settleSeats(record: Held): Promise<void> {
    const userId = String(record.userId);
    if (record.from) {
      if (record.wasActive && !record.seatReleased) {
        const released = await deps.releaseSeat(record.from, moveId(record));
        await checkpoint(record, {
          $set: { seatReleased: true, ...(released === 'drift' ? { seatDrift: true } : null) },
        });
      }
      await deps.syncMember({ tenantId: record.from, userId });
      await clearOverrides(record.from);
    }
    if (record.to) {
      await deps.syncMember({ tenantId: record.to, userId });
    }
    await clearOverrides(record.to ?? undefined);
  }

  async function clearOverrides(tenantId?: string): Promise<void> {
    try {
      await deps.clearOverrides?.(tenantId);
    } catch (error) {
      logger.error(`[bdren] clearing config overrides of ${tenantId ?? 'no tenant'} failed`, error);
    }
  }

  async function audit(record: Held, finished: Held, extra: Record<string, string> = {}) {
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
          status: finished.status,
          mode: finished.mode ?? null,
          ...prefixed('moved_', finished.moved ?? {}),
          ...prefixed('conflicts_', finished.conflicts ?? {}),
          keptOwner: String(record.userId),
          heir: plan?.heir ?? null,
          heirIsUser: plan?.heirIsUser ?? false,
          keptAgents: plan?.keptAgents.join(',') ?? '',
          keptPromptGroups: plan?.keptPromptGroups.join(',') ?? '',
          keptMcpServers: plan?.keptMcpServers.join(',') ?? '',
          keptSkills: plan?.keptSkills.join(',') ?? '',
          keptFiles: plan?.keptFiles.join(',') ?? '',
          renamed: (plan?.renames ?? [])
            .map((rename) => `${rename.model}:${rename.from}->${rename.to}`)
            .join(','),
          removedServers: (plan?.strippedServers ?? [])
            .map((stripped) => `${stripped.agent}:${stripped.name}`)
            .join(','),
          droppedGrantCount: finished.droppedGrants?.length ?? 0,
          droppedGrants: (finished.droppedGrants ?? []).join(','),
          seatDrift: finished.seatDrift ?? false,
          ...extra,
        },
        tenantId: undefined,
      });
    } catch (error) {
      logger.error('[bdren] recording the member move failed', error);
    }
  }

  async function finish(record: Held): Promise<MoveOutcome> {
    const finished = await moves()
      .findOneAndUpdate(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        {
          $set: {
            status: 'done',
            finishedAt: now(),
            leaseId: null,
            leaseUntil: null,
            lateSweepAt: new Date(now().getTime() + lateSweepMs),
            lateSweptAt: null,
          },
        },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!finished) {
      throw new LeaseLost();
    }
    await fence(record.userId, null);
    await audit(record, finished);
    await forgetSeats(finished);
    schedule(() => {
      sweepLate(moveId(record)).catch((error) =>
        logger.error('[bdren] late sweep after a member move failed', error),
      );
    }, lateSweepMs);
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
      moved: finished.moved ?? {},
      conflicts: finished.conflicts ?? {},
    };
  }

  async function refuse(record: Held, reason: MoveRefusal): Promise<MoveOutcome> {
    await returnSeat(record);
    await moves()
      .updateOne(
        { _id: record._id, leaseId: record.leaseId },
        {
          $set: {
            status: 'refused',
            refusal: reason,
            leaseId: null,
            leaseUntil: null,
            seatReserved: false,
          },
        },
      )
      .exec();
    await fence(record.userId, null);
    await forgetSeats(record);
    return { status: 'refused', reason };
  }

  /**
   * The person's data goes back to wherever they are now: someone else placed them in another
   * tenant mid-move (`redirected`), or the move had to be refused after it started (`refusal`).
   * Each source is planned afresh. Only `from` is left with leave rules (kept items, heir,
   * clean-up), and only when the person really was a member there; the move's own target was
   * never theirs, so everything in it comes back. The seat the move took is given back.
   */
  async function redirect(record: Held, refusal?: MoveRefusal): Promise<MoveOutcome> {
    const user = await runAsSystem(() => users().findById(record.userId).lean<IUser>().exec());
    if (!user) {
      return refuse(record, 'not_found');
    }
    const target = user.tenantId || null;
    const from = record.from ?? null;
    const to = record.to ?? null;
    const sources: Array<{ source: string | null; leave: boolean }> = [
      ...(from !== target ? [{ source: from, leave: from != null }] : []),
      ...(to !== target && to !== from ? [{ source: to, leave: false }] : []),
    ];
    const moved: Record<string, number> = {};
    for (const { source, leave } of sources) {
      const plan = await makePlan(String(record.userId), source, target, leave);
      const ctx = {
        ...contextFor(record, user, plan, source, target, leave),
        heartbeat: () => checkpoint(record, {}),
      };
      const result = await runAsSystem(() => sweepSteps(ctx));
      for (const [key, count] of Object.entries(result.moved)) {
        moved[key] = (moved[key] ?? 0) + count;
      }
    }
    if (target === from && record.strippedDetails?.length) {
      moved['moved.restoredServers'] = await runAsSystem(() =>
        restoreStripped(record.strippedDetails ?? []),
      );
    }
    await returnSeat(record);
    const finished = await moves()
      .findOneAndUpdate(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        {
          $set: {
            status: refusal ? 'refused' : 'redirected',
            ...(refusal ? { refusal } : null),
            finishedAt: now(),
            leaseId: null,
            leaseUntil: null,
            seatReserved: false,
          },
          $inc: moved,
        },
        { new: true },
      )
      .lean<Held>()
      .exec();
    await fence(record.userId, null);
    if (finished) {
      await audit(record, finished, { redirectedTo: target ?? '' });
      await forgetSeats(finished);
    }
    logger.warn(
      `[bdren] user ${String(record.userId)}'s move to ${to ?? 'no tenant'} ${
        refusal ? `was refused (${refusal})` : `ended in ${target ?? 'no tenant'}`
      }; their data is with them in ${target ?? 'no tenant'}`,
    );
    return refusal ? { status: 'refused', reason: refusal } : { status: 'redirected', to: target };
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
      if (!(await deps.reserveSeat(record.to, moveId(record)))) {
        return refuse(record, 'full');
      }
      await checkpoint(record, { $set: { seatReserved: true } });
    }
    await fence(record.userId, leaseUntil());
    if (!record.plan) {
      await checkpoint(record, {
        $set: {
          plan: await makePlan(String(record.userId), record.from ?? null, record.to ?? null),
        },
      });
    }
    await reload();
    const user = await runAsSystem(() => users().findById(record.userId).lean<IUser>().exec());
    if (!user) {
      return refuse(record, 'not_found');
    }
    const ctx = contextFor(record, user, record.plan as MemberMovePlan);
    const current = user.tenantId || null;
    const switched = record.userSwitched || current === (record.to ?? null);
    if (!switched && current !== (record.from ?? null)) {
      return redirect(record);
    }
    if (!switched) {
      if (
        !(record.completed ?? []).length &&
        (await hasDuplicateAccount(user, record.to ?? null))
      ) {
        return refuse(record, 'duplicate_account');
      }
      try {
        const useTransaction =
          record.mode !== 'sequential' &&
          (await transactions()) &&
          (await weight(ctx)) <= transactionDocLimit;
        if (useTransaction) {
          try {
            await runAsSystem(() => inTransaction(record, ctx, user));
          } catch (error) {
            if (
              error instanceof LeaseLost ||
              error instanceof SwitchMismatch ||
              error instanceof DuplicateAccount
            ) {
              throw error;
            }
            logger.warn(
              `[bdren] moving ${ctx.userId} in a transaction failed; continuing step by step`,
              error,
            );
            await reload();
            await runAsSystem(() => sequential(record, ctx, user));
          }
        } else {
          await runAsSystem(() => sequential(record, ctx, user));
        }
      } catch (error) {
        if (error instanceof SwitchMismatch) {
          await reload();
          return redirect(record);
        }
        if (error instanceof DuplicateAccount) {
          await reload();
          return redirect(record, 'duplicate_account');
        }
        throw error;
      }
      await reload();
    }
    await settleSeats(record);
    await runAsSystem(() => sweep(record, ctx));
    return finish(record);
  }

  async function run(acquired: Acquired): Promise<MoveOutcome> {
    if (acquired.status === 'done') {
      return acquired.outcome;
    }
    const { record } = acquired;
    try {
      return await drive(record);
    } catch (error) {
      if (!(error instanceof LeaseLost)) {
        await letGo(record, error).catch((cleanup) =>
          logger.error(`[bdren] releasing member move ${moveId(record)} failed`, cleanup),
        );
      }
      throw error;
    }
  }

  /**
   * After a failure this trigger gives the move up for the next one, but only while it still
   * holds it (another trigger's move is never touched). The fence stays until it expires (at most
   * one lease) once records have moved, so the person does not write into the old tenant while
   * half-moved; with nothing moved yet it is lifted. A move out of attempts is marked failed.
   */
  async function letGo(record: Held, error: unknown): Promise<void> {
    const released = await moves()
      .findOneAndUpdate(
        { _id: record._id, leaseId: record.leaseId, status: 'running' },
        { $set: { leaseUntil: now() } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!released) {
      return;
    }
    if (exhausted(released)) {
      await fail(released, error instanceof Error ? error.message : 'error');
      return;
    }
    const halfMoved =
      released.userSwitched === true ||
      Object.values(released.moved ?? {}).some((count) => count > 0);
    if (!halfMoved) {
      await fence(record.userId, null);
    }
  }

  /** The second sweep, once requests that were running under the old tenant have finished. */
  async function sweepLate(id: string): Promise<boolean> {
    const record = await moves()
      .findOneAndUpdate(
        { _id: id, status: 'done', lateSweptAt: null, lateSweepAt: { $lte: now() } },
        { $set: { lateSweptAt: now() } },
        { new: true },
      )
      .lean<Held>()
      .exec();
    if (!record?.plan) {
      return false;
    }
    const user = await runAsSystem(() => users().findById(record.userId).lean<IUser>().exec());
    if (!user || (user.tenantId || null) !== (record.to ?? null)) {
      return false;
    }
    const { moved } = await runAsSystem(() =>
      sweepSteps(contextFor(record, user, record.plan as MemberMovePlan)),
    );
    if (Object.keys(moved).length > 0) {
      await moves().updateOne({ _id: record._id }, { $inc: moved }).exec();
      logger.info(
        `[bdren] late sweep for user ${String(record.userId)} moved ${JSON.stringify(moved)}`,
      );
    }
    return true;
  }

  return {
    move: (request) => acquire({ ...request, userId: String(request.userId) }).then(run),
    async resume(userId) {
      const running = await findRunning(String(userId));
      return running ? run(await claim(running)) : null;
    },
    async resumeStranded() {
      const [stranded, due] = await Promise.all([
        moves()
          .find({ status: 'running', $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now() } }] })
          .limit(50)
          .lean<Held[]>()
          .exec(),
        moves()
          .find({ status: 'done', lateSweptAt: null, lateSweepAt: { $lte: now() } })
          .select('_id')
          .limit(50)
          .lean<Held[]>()
          .exec(),
      ]);
      let resumed = 0;
      for (const record of stranded) {
        try {
          const outcome = await run(await claim(record));
          resumed += outcome.status === 'busy' ? 0 : 1;
        } catch (error) {
          logger.error(`[bdren] resuming member move ${String(record._id)} failed`, error);
        }
      }
      let swept = 0;
      for (const record of due) {
        swept += (await sweepLate(String(record._id)).catch(() => false)) ? 1 : 0;
      }
      return { resumed, swept };
    },
    sweepLate,
  };
}
