import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import type { ChildProcess } from 'node:child_process';
import type { Account, AgentOverride, Deployed, Variant } from './types.ts';
import { HERE } from './config.ts';

export const TENANT = 'eval-office';
export const ADMIN_EMAIL = 'eval-admin@example.test';
const MASTER_ID = 'agent_office_assistant';
const HEALTH_TIMEOUT_MS = 180_000;

export interface StackOptions {
  appRoot: string;
  envFile: string;
  port: number;
  mongo: string;
  db: string;
  outDir: string;
  /** Code sandbox base URL; overrides LIBRECHAT_CODE_BASEURL from the env file when set. */
  sandbox?: string;
}

interface AgentDef {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  provider: string;
  model: string;
  tools?: string[];
  model_parameters?: Record<string, string | number | boolean>;
  skills_enabled?: boolean;
}

interface Manifest {
  master: AgentDef;
  specialists: AgentDef[];
}

interface ModelSpec {
  name: string;
  label?: string;
  default?: boolean;
  preset?: { endpoint?: string; agent_id?: string };
}

interface AppConfig {
  modelSpecs?: { enforce?: boolean; list?: ModelSpec[] };
}

export const baseUrl = (options: StackOptions): string => `http://localhost:${options.port}`;

const mongoUri = (options: StackOptions): string =>
  `${options.mongo.replace(/\/$/, '')}/${options.db}?directConnection=true`;

export function readEnvFile(file: string): Record<string, string> {
  return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

/** Secrets come from the env file via `-r dotenv/config`; these overrides win because dotenv never overwrites. */
function childEnv(options: StackOptions, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOTENV_CONFIG_PATH: options.envFile,
    NODE_ENV: 'production',
    PORT: String(options.port),
    MONGO_URI: mongoUri(options),
    DOMAIN_CLIENT: baseUrl(options),
    DOMAIN_SERVER: baseUrl(options),
    PLATFORM_SUPERADMIN_EMAILS: ADMIN_EMAIL,
    LANGFUSE_TRACING_ENABLED: 'false',
    ALLOW_UNVERIFIED_EMAIL_LOGIN: 'true',
    CONFIG_PATH: path.join(options.outDir, 'librechat.yaml'),
    ...(options.sandbox ? { LIBRECHAT_CODE_BASEURL: options.sandbox } : {}),
    ...extra,
  };
}

function exec(
  command: string,
  args: string[],
  options: StackOptions,
  logFile: string,
  extra = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(logFile, 'a');
    const child = spawn(command, args, {
      cwd: options.appRoot,
      env: childEnv(options, extra),
      stdio: ['ignore', log, log],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      fs.closeSync(log);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n');
      reject(
        new Error(`${path.basename(args[args.length - 1] ?? command)} exited ${code}:\n${tail}`),
      );
    });
  });
}

export async function withDb<T>(
  options: StackOptions,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(mongoUri(options), { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function dropDatabase(options: StackOptions): Promise<void> {
  if (/prod/i.test(options.db)) {
    throw new Error(`refusing to drop ${options.db}: it looks like a production database`);
  }
  await withDb(options, (client) => client.db(options.db).dropDatabase());
}

export async function seed(
  options: StackOptions,
  admin: Account,
  members: Account[],
): Promise<void> {
  await exec(
    'node',
    ['-r', 'dotenv/config', path.join(HERE, 'seed.ts')],
    options,
    path.join(options.outDir, 'seed.log'),
    {
      EVAL_SEED: JSON.stringify({ tenantId: TENANT, admin, members }),
    },
  );
}

const replaceIds = (text: string | undefined, ids: Record<string, string>): string | undefined =>
  text &&
  Object.entries(ids).reduce(
    (acc, [from, to]) => acc.replace(new RegExp(`\\b${from}\\b`, 'g'), to),
    text,
  );

function applyOverride(def: AgentDef, override: AgentOverride | undefined): AgentDef {
  if (!override) {
    return def;
  }
  const { instructions_append, ...fields } = override;
  const merged = { ...def, ...fields };
  return instructions_append
    ? { ...merged, instructions: `${merged.instructions ?? ''}\n\n${instructions_append}` }
    : merged;
}

/** The variant's manifest with every agent renamed, so all variants live side by side in one database. */
export function variantManifest(variant: Variant): {
  manifest: Manifest;
  specialistIds: Record<string, string>;
} {
  const base = yaml.load(fs.readFileSync(variant.manifest, 'utf8')) as Manifest;
  const kept = base.specialists.filter((spec) => !variant.drop_specialists?.includes(spec.id));
  const unknown = Object.keys(variant.specialists ?? {}).filter(
    (id) => !kept.some((spec) => spec.id === id),
  );
  if (unknown.length) {
    throw new Error(
      `${variant.source}: no specialist ${unknown.join(', ')} in ${variant.manifest}`,
    );
  }
  const specialistIds = Object.fromEntries(
    kept.map((spec) => [spec.id, `${spec.id}_${variant.id}`]),
  );
  const ids = { ...specialistIds, [base.master.id]: `agent_eval_${variant.id}` };
  const rename = (def: AgentDef): AgentDef => ({
    ...def,
    id: ids[def.id],
    instructions: replaceIds(def.instructions, ids),
  });
  return {
    manifest: {
      master: rename(applyOverride(base.master, variant.master)),
      specialists: kept.map((spec) => rename(applyOverride(spec, variant.specialists?.[spec.id]))),
    },
    specialistIds,
  };
}

export async function deployVariant(options: StackOptions, variant: Variant): Promise<Deployed> {
  const { manifest, specialistIds } = variantManifest(variant);
  const file = path.join(options.outDir, 'variants', `${variant.id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(manifest, { lineWidth: 120 }));
  await exec(
    'node',
    [
      '-r',
      'dotenv/config',
      'config/sync-office-agents.js',
      `--manifest=${file}`,
      `--author=${ADMIN_EMAIL}`,
      `--tenant=${TENANT}`,
      '--public',
      '--apply',
    ],
    options,
    path.join(options.outDir, `sync-${variant.id}.log`),
  );
  return { variant, spec: `eval-${variant.id}`, agentId: manifest.master.id, specialistIds };
}

/** The app's librechat.yaml plus one enforced model spec per variant, cloned from the Office Assistant's. */
export function writeAppConfig(options: StackOptions, deployed: Deployed[]): void {
  const config = yaml.load(
    fs.readFileSync(path.join(options.appRoot, 'librechat.yaml'), 'utf8'),
  ) as AppConfig;
  const list = config.modelSpecs?.list ?? [];
  const template = list.find((spec) => spec.preset?.agent_id === MASTER_ID) ?? {
    name: 'office-assistant',
    preset: { endpoint: 'agents', agent_id: MASTER_ID },
  };
  const specs = deployed.map(({ variant, spec, agentId }) => ({
    ...template,
    name: spec,
    label: `Eval: ${variant.label}`,
    default: false,
    preset: { ...template.preset, agent_id: agentId },
  }));
  const next = { ...config, modelSpecs: { ...config.modelSpecs, list: [...list, ...specs] } };
  fs.writeFileSync(
    path.join(options.outDir, 'librechat.yaml'),
    yaml.dump(next, { lineWidth: -1, noRefs: true }),
  );
}

async function healthy(options: StackOptions): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(options)}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startServer(
  options: StackOptions,
  skillsDir: string,
  label: string,
): Promise<ChildProcess> {
  if (await healthy(options)) {
    throw new Error(
      `something is already serving ${baseUrl(options)}; pass --port to use another port`,
    );
  }
  if (!fs.existsSync(path.join(options.appRoot, 'client', 'dist', 'index.html'))) {
    throw new Error(`${options.appRoot} is not built: run npm run build there first`);
  }
  const logFile = path.join(options.outDir, `server-${label}.log`);
  const log = fs.openSync(logFile, 'a');
  const child = spawn('node', ['-r', 'dotenv/config', 'api/server/index.js'], {
    cwd: options.appRoot,
    env: childEnv(options, { DEPLOYMENT_SKILLS_DIR: skillsDir }),
    stdio: ['ignore', log, log],
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    if (await healthy(options)) {
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill('SIGTERM');
  const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
  throw new Error(`the server did not come up (log ${logFile}):\n${tail}`);
}

export function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

const errorLog = (appRoot: string): string =>
  path.join(appRoot, 'logs', `error-${new Date().toISOString().slice(0, 10)}.log`);

/** Byte offset of today's error log, to read only what this run adds. */
export function errorLogMark(appRoot: string): { file: string; offset: number } {
  const file = errorLog(appRoot);
  return { file, offset: fs.existsSync(file) ? fs.statSync(file).size : 0 };
}

export function errorLogSince(mark: { file: string; offset: number }): string[] {
  if (!fs.existsSync(mark.file)) {
    return [];
  }
  const fd = fs.openSync(mark.file, 'r');
  const size = fs.statSync(mark.file).size;
  const buffer = Buffer.alloc(Math.max(0, size - mark.offset));
  fs.readSync(fd, buffer, 0, buffer.length, mark.offset);
  fs.closeSync(fd);
  return buffer
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}
