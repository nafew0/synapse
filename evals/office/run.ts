/**
 * Office Assistant evaluation: runs every case against every variant (prompt × skills × model)
 * on a throwaway local stack, grades the delivered files, asks a judge model to score them, and
 * writes report.html / report.json. See README.md.
 *
 *   node evals/office/run.ts [--cases a,b] [--variants x,y] [--repeat N] [--concurrency N] ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import type { ChildProcess } from 'node:child_process';
import type {
  Account,
  Check,
  Deployed,
  EvalCase,
  Judgement,
  Report,
  RunResult,
  TurnResult,
  Usage,
  Variant,
} from './types.ts';
import {
  ADMIN_EMAIL,
  baseUrl,
  deployVariant,
  dropDatabase,
  errorLogMark,
  errorLogSince,
  readEnvFile,
  seed,
  startServer,
  stopServer,
  variantManifest,
  withDb,
  writeAppConfig,
} from './stack.ts';
import { Client, deliveredFiles, replyText, toolCalls } from './client.ts';
import { aggregate, compare, summary, writeBaseline, writeReport } from './report.ts';
import { HERE, loadCases, loadVariants } from './config.ts';
import { grade, probe } from './grade.ts';
import { judge } from './judge.ts';

const DEFAULT_JUDGE = 'anthropic/claude-sonnet-5.5';
const HANDOFF_PREFIX = 'lc_transfer_to_';

const { values: args } = parseArgs({
  options: {
    cases: { type: 'string' },
    variants: { type: 'string' },
    repeat: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    app: { type: 'string', default: path.resolve(HERE, '..', '..') },
    env: { type: 'string' },
    port: { type: 'string', default: '3190' },
    mongo: { type: 'string', default: 'mongodb://127.0.0.1:27017' },
    db: { type: 'string', default: 'SynapseEvalOffice' },
    judge: { type: 'string', default: DEFAULT_JUDGE },
    'no-judge': { type: 'boolean', default: false },
    out: { type: 'string' },
    baseline: { type: 'string', default: path.join(HERE, 'baseline.json') },
    accept: { type: 'boolean', default: false },
    'keep-db': { type: 'boolean', default: false },
    regrade: { type: 'string' },
    rejudge: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
    remote: { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const USAGE = `Usage: node evals/office/run.ts [options]

Selection
  --cases a,b,docx*      case ids or categories (a trailing * matches a prefix); default all
  --variants x,y         variant ids from variants/; default all
  --repeat N             run every case N times (overrides each case's repeat)
  --list                 print the cases and variants, then exit

Stack (local mode)
  --app PATH             app checkout to run (default: this checkout); must be built
  --env PATH             env file with secrets (default: the main checkout's .env)
  --port N               port for the eval server (default 3190)
  --mongo URI            MongoDB server (default mongodb://127.0.0.1:27017)
  --db NAME              throwaway database, dropped before and after (default SynapseEvalOffice)
  --concurrency N        parallel chats; one seeded account each (default 2)
  --keep-db              leave the database for inspection

Remote mode
  --remote URL           run against a deployed instance as EVAL_EMAIL / EVAL_PASSWORD;
                         variants are ignored and the deployed Office Assistant is tested

Grading and output
  --judge MODEL          OpenRouter model that scores the work (default ${DEFAULT_JUDGE})
  --no-judge             skip the judge
  --out DIR              output directory (default evals/office/out/<run id>)
  --baseline FILE        compare against this baseline (default evals/office/baseline.json)
  --accept               save this run as the new baseline
  --regrade DIR          re-grade an earlier run's saved files with the current cases (no chats)
  --rejudge              with --regrade, ask the judge again instead of keeping its verdicts
  --strict               exit 1 when any run fails, not only on regressions`;

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const appRoot = path.resolve(args.app);
const remote = args.remote?.replace(/\/$/, '');
const concurrency = remote ? 1 : Math.max(1, Number(args.concurrency));
const repeatOverride = args.repeat ? Math.max(1, Number(args.repeat)) : undefined;

function git(...command: string[]): string {
  try {
    return execFileSync('git', ['-C', appRoot, ...command], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function defaultEnvFile(): string {
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const main = path.join(path.dirname(common), '.env');
  return fs.existsSync(main) ? main : path.join(appRoot, '.env');
}

const envFile = path.resolve(args.env ?? defaultEnvFile());
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
const outDir = path.resolve(args.out ?? path.join(HERE, 'out', runId));

const stackOptions = {
  appRoot,
  envFile,
  port: Number(args.port),
  mongo: args.mongo,
  db: args.db,
  outDir,
};

interface Job {
  evalCase: EvalCase;
  deployed: Deployed;
  attempt: number;
}

const log = (line: string) => console.log(line);

function remoteDeployed(): Deployed {
  const variant: Variant = {
    id: 'deployed',
    label: `Deployed at ${remote}`,
    manifest: path.join(appRoot, 'config', 'phase-one-office-agents.yaml'),
    skills: path.join(appRoot, 'skill'),
    source: 'remote',
  };
  const manifest = yaml.load(fs.readFileSync(variant.manifest, 'utf8')) as {
    specialists: { id: string }[];
  };
  return {
    variant,
    spec: 'office-assistant',
    agentId: 'agent_office_assistant',
    specialistIds: Object.fromEntries(manifest.specialists.map((spec) => [spec.id, spec.id])),
  };
}

function variantModels(deployed: Deployed): string[] {
  if (deployed.variant.source === 'remote') {
    return [];
  }
  const { manifest } = variantManifest(deployed.variant);
  const specialists = manifest.specialists.map((spec) => `${spec.name}: ${spec.model}`);
  return [`master: ${manifest.master.model}`, ...specialists];
}

function skillsOf(calls: TurnResult['toolCalls']): string[] {
  return calls
    .filter((call) => call.name === 'skill')
    .map((call) => {
      try {
        const parsed = JSON.parse(call.args) as {
          name?: string;
          skill?: string;
          skillName?: string;
        };
        return parsed.name ?? parsed.skill ?? parsed.skillName ?? '';
      } catch {
        return call.args.match(/"(?:name|skill|skillName)"\s*:\s*"([^"]+)"/)?.[1] ?? '';
      }
    })
    .filter(Boolean);
}

function handoffsOf(calls: TurnResult['toolCalls'], deployed: Deployed): string[] {
  const byEvalId = new Map(
    Object.entries(deployed.specialistIds).map(([base, evalId]) => [evalId, base]),
  );
  return calls
    .filter((call) => call.name.startsWith(HANDOFF_PREFIX))
    .map((call) => {
      const target = call.name.slice(HANDOFF_PREFIX.length);
      return byEvalId.get(target) ?? target;
    });
}

async function runJob(client: Client, job: Job): Promise<RunResult> {
  const { evalCase, deployed, attempt } = job;
  const key = `${deployed.variant.id}/${evalCase.id}/${attempt}`;
  const dir = path.join(outDir, 'runs', deployed.variant.id, `${evalCase.id}-${attempt}`);
  const rendersDir = path.join(dir, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const target = { spec: deployed.spec, agentId: deployed.agentId };
  const startedAt = new Date();
  const turns: TurnResult[] = [];
  let conversationId: string | undefined;
  let parentMessageId: string | undefined;
  const answers = [...evalCase.answers];

  for (const [index, turn] of evalCase.turns.entries()) {
    try {
      const files = await Promise.all(turn.attach.map((file) => client.upload(file, target)));
      const outcome = await client.send(target, {
        text: turn.text,
        files,
        conversationId,
        parentMessageId,
        timeoutSeconds: evalCase.timeoutSeconds,
        answers,
        log: (line) => fs.appendFileSync(path.join(dir, 'poll.log'), `turn ${index + 1} ${line}\n`),
      });
      answers.splice(0, outcome.questions.length);
      const calls = toolCalls(outcome.message);
      const turnDir = path.join(dir, `turn-${index + 1}`);
      const attachments = await Promise.all(
        deliveredFiles(outcome.message).map((item) => client.download(item, turnDir)),
      );
      const downloaded = attachments.map((a) => a.path).filter((p): p is string => p != null);
      const reports = await probe(downloaded, rendersDir);
      turns.push({
        index,
        prompt: turn.text,
        conversationId: outcome.conversationId,
        messageId: outcome.message?.messageId,
        seconds: outcome.seconds,
        finished: outcome.finished,
        error:
          outcome.error ?? (outcome.message?.error ? 'the reply was saved as an error' : undefined),
        reply: replyText(outcome.message),
        toolCalls: calls,
        skills: skillsOf(calls),
        handoffs: handoffsOf(calls, deployed),
        questions: outcome.questions,
        attachments,
        files: reports,
      });
      fs.writeFileSync(
        path.join(dir, `turn-${index + 1}.json`),
        JSON.stringify(outcome.message ?? null, null, 2),
      );
      conversationId = outcome.conversationId;
      parentMessageId = outcome.message?.messageId;
      if (!outcome.finished || !parentMessageId) {
        break;
      }
    } catch (error) {
      turns.push({
        index,
        prompt: turn.text,
        conversationId: conversationId ?? '',
        seconds: 0,
        finished: false,
        error: (error as Error).message,
        reply: '',
        toolCalls: [],
        skills: [],
        handoffs: [],
        questions: [],
        attachments: [],
        files: [],
      });
      break;
    }
  }

  const { checks, verdict } = await assess(evalCase, turns, rendersDir);
  const result: RunResult = {
    key,
    caseId: evalCase.id,
    variantId: deployed.variant.id,
    attempt,
    category: evalCase.category,
    startedAt: startedAt.toISOString(),
    seconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    turns,
    checks,
    judge: verdict,
    pass: checks.every((check) => check.ok),
    dir,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

/** Grades a run's turns and, unless a verdict is passed in to keep, asks the judge. */
async function assess(
  evalCase: EvalCase,
  turns: TurnResult[],
  rendersDir: string,
  kept?: Judgement,
): Promise<{ checks: Check[]; verdict?: Judgement }> {
  const checks = await grade(turns, evalCase, rendersDir);
  const judgeKey = judgeApiKey();
  const produced = turns.some((turn) => turn.finished);
  const verdict =
    kept ?? (judgeKey && produced ? await judge(evalCase, turns, args.judge, judgeKey) : undefined);
  if (verdict && !verdict.error) {
    checks.push({
      layer: 'quality',
      label: `judge score ≥ ${evalCase.minScore}`,
      ok: verdict.score >= evalCase.minScore,
      detail: `${verdict.score}/5 — ${verdict.summary}`,
    });
  }
  return { checks, verdict };
}

/**
 * Re-inspects and re-grades the files an earlier run saved, against the current case
 * definitions, without chatting again. Keeps the judge's verdicts unless --rejudge.
 */
async function regrade(dir: string): Promise<Report> {
  const previous = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as Report;
  const cases = new Map(loadCases().map((item) => [item.id, item]));
  const runs: RunResult[] = [];
  for (const run of previous.runs) {
    const evalCase = cases.get(run.caseId);
    if (!evalCase) {
      log(`  ! ${run.caseId} no longer exists: kept as graded before`);
      runs.push(run);
      continue;
    }
    const rendersDir = path.join(run.dir, 'renders');
    const turns: TurnResult[] = [];
    for (const turn of run.turns) {
      const saved = turn.attachments.map((a) => a.path).filter((p): p is string => p != null);
      turns.push({ ...turn, files: await probe(saved, rendersDir) });
    }
    const kept = args.rejudge ? undefined : run.judge;
    const { checks, verdict } = await assess(evalCase, turns, rendersDir, kept);
    const next = { ...run, turns, checks, judge: verdict, pass: checks.every((c) => c.ok) };
    log(`  ${next.pass ? '✓' : '✗'} ${run.variantId} · ${run.caseId} #${run.attempt}`);
    runs.push(next);
  }
  const aggregates = aggregate(runs);
  return {
    ...previous,
    runs,
    aggregates,
    regressions: compare(aggregates, args.baseline),
    judgeCostUsd: runs.reduce((sum, run) => sum + (run.judge?.costUsd ?? 0), 0),
  };
}

let cachedJudgeKey: string | null | undefined;

function judgeApiKey(): string | null {
  if (cachedJudgeKey !== undefined) {
    return cachedJudgeKey;
  }
  if (args['no-judge']) {
    cachedJudgeKey = null;
    return cachedJudgeKey;
  }
  cachedJudgeKey = process.env.OPENROUTER_KEY ?? readEnvFile(envFile).OPENROUTER_KEY ?? null;
  if (!cachedJudgeKey) {
    log(`! no OPENROUTER_KEY in the environment or ${envFile}: the judge is off`);
  }
  return cachedJudgeKey;
}

/** Runs jobs on a pool where each worker owns one account, so no account exceeds one live chat. */
async function runPool(
  jobs: Job[],
  clients: Client[],
  done: RunResult[],
  total: number,
): Promise<void> {
  const queue = [...jobs];
  const worker = async (client: Client) => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const label = `${job.deployed.variant.id} · ${job.evalCase.id} #${job.attempt}`;
      log(`  → ${label}`);
      const result = await runJob(client, job);
      done.push(result);
      const score = result.judge?.score ? ` judge ${result.judge.score}/5` : '';
      const failed = result.checks.filter((check) => !check.ok).length;
      log(
        `  ${result.pass ? '✓' : '✗'} [${done.length}/${total}] ${label} ${result.seconds}s${score}${failed ? ` (${failed} failed check(s))` : ''}`,
      );
    }
  };
  await Promise.all(clients.map(worker));
}

function buildJobs(cases: EvalCase[], deployed: Deployed[]): Job[] {
  const most = Math.max(...cases.map((item) => repeatOverride ?? item.repeat));
  const jobs: Job[] = [];
  for (let attempt = 1; attempt <= most; attempt++) {
    for (const evalCase of cases) {
      if (attempt > (repeatOverride ?? evalCase.repeat)) {
        continue;
      }
      for (const variant of deployed) {
        jobs.push({ evalCase, deployed: variant, attempt });
      }
    }
  }
  return jobs;
}

interface TransactionRow {
  conversationId: string;
  tokenType?: string;
  rawAmount?: number;
  tokenValue?: number;
  model?: string;
}

async function attachUsage(runs: RunResult[]): Promise<void> {
  const ids = runs.flatMap((run) => run.turns.map((turn) => turn.conversationId)).filter(Boolean);
  if (!ids.length) {
    return;
  }
  const rows = await withDb(stackOptions, (client) =>
    client
      .db(stackOptions.db)
      .collection<TransactionRow>('transactions')
      .find({ conversationId: { $in: ids } })
      .toArray(),
  );
  const byConversation = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    byConversation.set(row.conversationId, [
      ...(byConversation.get(row.conversationId) ?? []),
      row,
    ]);
  }
  for (const run of runs) {
    const mine = [...new Set(run.turns.map((turn) => turn.conversationId))].flatMap(
      (id) => byConversation.get(id) ?? [],
    );
    if (!mine.length) {
      continue;
    }
    const usage: Usage = {
      promptTokens: mine
        .filter((r) => r.tokenType === 'prompt')
        .reduce((sum, r) => sum - (r.rawAmount ?? 0), 0),
      completionTokens: mine
        .filter((r) => r.tokenType === 'completion')
        .reduce((sum, r) => sum - (r.rawAmount ?? 0), 0),
      costUsd: mine.reduce((sum, r) => sum - (r.tokenValue ?? 0), 0) / 1_000_000,
      models: [...new Set(mine.map((r) => r.model).filter((m): m is string => !!m))],
    };
    run.usage = usage;
  }
}

function membersFor(count: number, password: string): Account[] {
  return Array.from({ length: count }, (_, index) => ({
    email: `eval-member-${index + 1}@example.test`,
    password,
  }));
}

let server: ChildProcess | undefined;

async function runLocal(
  cases: EvalCase[],
  variants: Variant[],
  done: RunResult[],
): Promise<{ deployed: Deployed[]; errors: string[] }> {
  const password = `Eval-${randomBytes(12).toString('base64url')}`;
  const members = membersFor(concurrency, password);
  log(`database ${args.db}: reset and seed ${members.length} account(s)`);
  await dropDatabase(stackOptions);
  await seed(stackOptions, { email: ADMIN_EMAIL, password }, members);
  const deployed: Deployed[] = [];
  for (const variant of variants) {
    log(
      `variant ${variant.id}: create agents from ${path.relative(appRoot, variant.manifest) || variant.manifest}`,
    );
    deployed.push(await deployVariant(stackOptions, variant));
  }
  writeAppConfig(stackOptions, deployed);

  const jobs = buildJobs(cases, deployed);
  const mark = errorLogMark(appRoot);
  const groups = new Map<string, Deployed[]>();
  for (const item of deployed) {
    groups.set(item.variant.skills, [...(groups.get(item.variant.skills) ?? []), item]);
  }
  let groupIndex = 0;
  for (const [skillsDir, group] of groups) {
    groupIndex++;
    log(
      `server ${groupIndex}/${groups.size} on ${baseUrl(stackOptions)} with skills from ${skillsDir}`,
    );
    server = await startServer(stackOptions, skillsDir, `group${groupIndex}`);
    try {
      const clients = await Promise.all(
        members.map((member) => Client.login(baseUrl(stackOptions), member)),
      );
      const ids = new Set(group.map((item) => item.variant.id));
      await runPool(
        jobs.filter((job) => ids.has(job.deployed.variant.id)),
        clients,
        done,
        jobs.length,
      );
    } finally {
      await stopServer(server);
      server = undefined;
    }
  }
  await attachUsage(done);
  return { deployed, errors: errorLogSince(mark) };
}

async function runRemote(
  cases: EvalCase[],
  done: RunResult[],
): Promise<{ deployed: Deployed[]; errors: string[] }> {
  const email = process.env.EVAL_EMAIL;
  const password = process.env.EVAL_PASSWORD;
  if (!remote || !email || !password) {
    throw new Error('--remote needs EVAL_EMAIL and EVAL_PASSWORD in the environment');
  }
  const deployed = [remoteDeployed()];
  const client = await Client.login(remote, { email, password });
  const jobs = buildJobs(cases, deployed);
  await runPool(jobs, [client], done, jobs.length);
  return { deployed, errors: [] };
}

async function main(): Promise<number> {
  if (args.regrade) {
    const dir = path.resolve(args.regrade);
    log(`re-grading ${dir}`);
    return finish(await regrade(dir), dir);
  }
  const cases = loadCases(list(args.cases));
  const variants = remote ? [] : loadVariants(appRoot, list(args.variants));
  if (args.list) {
    log('Cases');
    cases.forEach((item) =>
      log(
        `  ${item.id.padEnd(28)} ${item.category.padEnd(14)} ${item.turns.length} turn(s)  ${item.title}`,
      ),
    );
    log('Variants');
    variants.forEach((variant) => log(`  ${variant.id.padEnd(16)} ${variant.label}`));
    return 0;
  }
  if (!cases.length) {
    throw new Error('no cases selected: add YAML files to evals/office/cases or fix --cases');
  }
  if (!remote && !variants.length) {
    throw new Error(
      'no variants selected: add YAML files to evals/office/variants or fix --variants',
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  log(
    `office eval ${runId}: ${cases.length} case(s) × ${remote ? 1 : variants.length} variant(s), output ${outDir}`,
  );
  log(
    `app ${appRoot} (${git('rev-parse', '--abbrev-ref', 'HEAD')} @ ${git('rev-parse', '--short', 'HEAD')}), env ${envFile}`,
  );

  const done: RunResult[] = [];
  const { deployed, errors } = remote
    ? await runRemote(cases, done)
    : await runLocal(cases, variants, done);

  const caseOrder = new Map(cases.map((item, index) => [item.id, index]));
  const variantOrder = new Map(deployed.map((item, index) => [item.variant.id, index]));
  done.sort(
    (a, b) =>
      (caseOrder.get(a.caseId) ?? 0) - (caseOrder.get(b.caseId) ?? 0) ||
      (variantOrder.get(a.variantId) ?? 0) - (variantOrder.get(b.variantId) ?? 0) ||
      a.attempt - b.attempt,
  );
  const aggregates = aggregate(done);
  const report: Report = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    app: {
      root: appRoot,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      commit: git('rev-parse', '--short', 'HEAD'),
    },
    options: {
      repeat: repeatOverride,
      concurrency,
      judge: judgeApiKey() ? args.judge : null,
      mode: remote ? 'remote' : 'local',
    },
    variants: deployed.map((item) => ({
      id: item.variant.id,
      label: item.variant.label,
      agentId: item.agentId,
      models: variantModels(item),
      skills: item.variant.skills,
    })),
    cases: cases.map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      turns: item.turns.length,
    })),
    runs: done,
    aggregates,
    regressions: compare(aggregates, args.baseline),
    serverErrors: errors,
    judgeCostUsd: done.reduce((sum, run) => sum + (run.judge?.costUsd ?? 0), 0),
  };
  return finish(report, outDir);
}

function finish(report: Report, dir: string): number {
  const files = writeReport(report, dir);
  if (args.accept) {
    writeBaseline(report, args.baseline);
  }
  log('');
  log(summary(report));
  log('');
  log(`report  ${files.html}`);
  log(`data    ${files.json}`);
  if (args.accept) {
    log(`baseline saved to ${args.baseline}`);
  }
  if (report.regressions.length) {
    return 1;
  }
  return args.strict && report.runs.some((run) => !run.pass) ? 1 : 0;
}

async function cleanup(): Promise<void> {
  await stopServer(server);
  if (!remote && !args['keep-db'] && !args.list && !args.regrade) {
    await dropDatabase(stackOptions).catch(() => undefined);
  }
}

process.on('SIGINT', () => {
  log('\ninterrupted: stopping the eval server');
  cleanup().finally(() => process.exit(130));
});

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (error: Error) => {
    console.error(`\n${error.message}`);
    await cleanup();
    process.exit(2);
  });
