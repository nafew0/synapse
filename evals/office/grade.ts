import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  Check,
  EvalCase,
  Expect,
  FileExpect,
  FileReport,
  Layer,
  TurnResult,
} from './types.ts';
import { HERE } from './config.ts';

const PROBE_DEPS = ['python-docx', 'python-pptx', 'openpyxl', 'pymupdf', 'pillow'];

/**
 * Failures that have reached users from the office pipeline (see scripts/check-office-pipeline.mjs).
 * Any of them in a tool output is a regression, not noise.
 */
const KNOWN_FAILURES: [string, RegExp][] = [
  ['relationships lost', /no relationship of type/],
  ['package unreadable', /source file could not be loaded|PackageNotFoundError/],
  ['scratch script gone', /Cannot find module|No such file or directory/],
  ['rebuild never landed', /mv: cannot stat/],
  ['sandbox rejected the call', /Conflicting input destinations|Execution error/],
  ['file missing in sandbox', /does not exist in the sandbox/],
  ['javaldx noise', /javaldx/i],
];

const USER_FACING_ERROR = /Something went wrong|Reference: [0-9a-f]{8}|An error occurred/i;

/** Inspects files with probe.py under uv, so no Python packages need installing. */
export function probe(files: string[], rendersDir: string): Promise<FileReport[]> {
  if (files.length === 0) {
    return Promise.resolve([]);
  }
  const args = [
    'run',
    '--quiet',
    '--no-project',
    ...PROBE_DEPS.flatMap((dep) => ['--with', dep]),
    'python',
    '-I',
  ];
  args.push(path.join(HERE, 'probe.py'), '--renders', rendersDir, ...files);
  return new Promise((resolve, reject) => {
    const child = spawn('uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk));
    child.on('error', (error) =>
      reject(new Error(`uv is required to inspect files: ${error.message}`)),
    );
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`probe.py exited ${code}: ${err.slice(-500)}`));
        return;
      }
      resolve(JSON.parse(out) as FileReport[]);
    });
  });
}

const fixtureCache = new Map<string, Promise<FileReport>>();

function probeFixture(file: string, rendersDir: string): Promise<FileReport> {
  const cached = fixtureCache.get(file);
  if (cached) {
    return cached;
  }
  const next = probe([file], rendersDir).then(([report]) => report);
  fixtureCache.set(file, next);
  return next;
}

/** Lowercases, folds typographic dashes and quotes, and collapses whitespace. */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

export function language(text: string): 'bn' | 'en' | 'mixed' {
  const bangla = (text.match(/[ঀ-৿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = bangla + latin;
  if (total === 0) {
    return 'mixed';
  }
  if (bangla / total > 0.6) {
    return 'bn';
  }
  return latin / total > 0.8 ? 'en' : 'mixed';
}

const extOf = (name: string): string => path.extname(name).slice(1).toLowerCase();

const exts = (item: FileExpect): string[] =>
  item.ext == null
    ? []
    : (Array.isArray(item.ext) ? item.ext : [item.ext]).map((e) => e.toLowerCase());

function matchesItem(file: FileReport, item: FileExpect): boolean {
  const wanted = exts(item);
  if (wanted.length && !wanted.includes(extOf(file.name))) {
    return false;
  }
  return item.name ? new RegExp(item.name, 'i').test(file.name) : true;
}

type Add = (layer: Layer, label: string, ok: boolean, detail?: string) => void;

const within = (value: number | undefined, min?: number, max?: number): boolean =>
  value != null && (min == null || value >= min) && (max == null || value <= max);

async function checkItem(
  file: FileReport,
  item: FileExpect,
  add: Add,
  rendersDir: string,
): Promise<void> {
  const name = file.name;
  const text = normalize(file.text);
  for (const needle of item.contains ?? []) {
    add('file', `${name} contains "${needle}"`, text.includes(normalize(needle)));
  }
  for (const needle of item.not_contains ?? []) {
    add('file', `${name} does not contain "${needle}"`, !text.includes(normalize(needle)));
  }
  if (item.slides != null || item.min_slides != null || item.max_slides != null) {
    const min = item.slides ?? item.min_slides;
    const max = item.slides ?? item.max_slides;
    add(
      'file',
      `${name} slide count`,
      within(file.slides, min, max),
      `${file.slides ?? '?'} slides, wanted ${min ?? '-'}..${max ?? '-'}`,
    );
  }
  if (item.min_pages != null || item.max_pages != null) {
    add(
      'file',
      `${name} page count`,
      within(file.pages, item.min_pages, item.max_pages),
      `${file.pages ?? '?'} pages`,
    );
  }
  const sheetNames = (file.sheets ?? []).map((sheet) => sheet.name.toLowerCase());
  for (const sheet of item.sheets ?? []) {
    add(
      'file',
      `${name} has sheet "${sheet}"`,
      sheetNames.includes(sheet.toLowerCase()),
      sheetNames.join(', '),
    );
  }
  if (file.kind === 'xlsx') {
    const formulas = (file.sheets ?? []).reduce((sum, sheet) => sum + sheet.formulas, 0);
    const errors = (file.sheets ?? []).reduce((sum, sheet) => sum + sheet.errors, 0);
    const uncached = (file.sheets ?? []).reduce((sum, sheet) => sum + sheet.uncached, 0);
    if (item.min_formulas != null) {
      add(
        'file',
        `${name} uses formulas`,
        formulas >= item.min_formulas,
        `${formulas} formulas, wanted ≥ ${item.min_formulas}`,
      );
    }
    if (item.no_errors !== false) {
      add('file', `${name} has no error cells`, errors === 0, `${errors} error values`);
      add(
        'file',
        `${name} formulas were recalculated`,
        uncached === 0,
        `${uncached} formulas without a cached value`,
      );
    }
  }
  const fonts = file.fonts.map((font) => font.toLowerCase());
  for (const font of item.fonts ?? []) {
    add(
      'file',
      `${name} uses font ${font}`,
      fonts.includes(font.toLowerCase()),
      file.fonts.join(', '),
    );
  }
  if (item.min_images != null) {
    add(
      'file',
      `${name} embeds images`,
      (file.images ?? 0) >= item.min_images,
      `${file.images ?? 0} images`,
    );
  }
  if (file.kind === 'image') {
    add('file', `${name} is not blank`, file.blank === false);
    if (item.min_width != null || item.min_height != null) {
      add(
        'file',
        `${name} size`,
        (file.width ?? 0) >= (item.min_width ?? 0) && (file.height ?? 0) >= (item.min_height ?? 0),
        `${file.width}×${file.height}`,
      );
    }
  }
  if (item.keeps_text_from) {
    const original = await probeFixture(item.keeps_text_from, rendersDir);
    const kept = original.paragraphs.filter((p) => p.length >= 20);
    const present = kept.filter((p) => text.includes(normalize(p)));
    const ratio = kept.length ? present.length / kept.length : 1;
    const wanted = item.keeps_ratio ?? 0.8;
    add(
      'file',
      `${name} keeps the original text`,
      ratio >= wanted,
      `${present.length}/${kept.length} paragraphs of ${path.basename(item.keeps_text_from)} kept (${Math.round(ratio * 100)}%, wanted ${Math.round(wanted * 100)}%)`,
    );
  }
}

async function checkFiles(
  turn: TurnResult,
  expect: Expect,
  add: Add,
  rendersDir: string,
): Promise<void> {
  const spec = expect.files;
  if (!spec) {
    return;
  }
  const files = turn.files;
  const names = files.map((file) => file.name).join(', ') || 'none';
  if (spec.count != null) {
    add('file', `delivers ${spec.count} file(s)`, files.length === spec.count, names);
  }
  if (spec.min != null || spec.max != null) {
    add(
      'file',
      `delivers ${spec.min ?? 0}..${spec.max ?? '∞'} file(s)`,
      within(files.length, spec.min, spec.max),
      names,
    );
  }
  const unused = [...files];
  for (const item of spec.items ?? []) {
    const index = unused.findIndex((file) => matchesItem(file, item));
    const label = [exts(item).join('/') || 'file', item.name].filter(Boolean).join(' ');
    if (index === -1) {
      add('file', `a ${label} was delivered`, false, names);
      continue;
    }
    const [file] = unused.splice(index, 1);
    add('file', `a ${label} was delivered`, true, file.name);
    await checkItem(file, item, add, rendersDir);
  }
}

function checkProcess(turn: TurnResult, expect: Expect, evalCase: EvalCase, add: Add): void {
  for (const skill of expect.skills ?? []) {
    add(
      'process',
      `loads the ${skill} skill`,
      turn.skills.includes(skill),
      turn.skills.join(', ') || 'no skills loaded',
    );
  }
  const names = turn.toolCalls.map((call) => call.name);
  for (const tool of expect.tools?.include ?? []) {
    add('process', `calls ${tool}`, names.includes(tool), [...new Set(names)].join(', '));
  }
  for (const tool of expect.tools?.exclude ?? []) {
    add('process', `does not call ${tool}`, !names.includes(tool));
  }
  if (expect.tools?.max_calls != null) {
    add(
      'process',
      `at most ${expect.tools.max_calls} tool calls`,
      names.length <= expect.tools.max_calls,
      `${names.length} calls`,
    );
  }
  for (const spec of expect.handoff ?? []) {
    add(
      'process',
      `hands off to ${spec}`,
      turn.handoffs.includes(spec),
      turn.handoffs.join(', ') || 'no handoffs',
    );
  }
  if (expect.no_handoff) {
    add(
      'process',
      'answers without a handoff',
      turn.handoffs.length === 0,
      turn.handoffs.join(', '),
    );
  }
  const asked = turn.questions.length > 0;
  if (expect.asks != null) {
    add(
      'process',
      expect.asks ? 'asks a clarifying question' : 'does not ask a question',
      asked === expect.asks,
      turn.questions.map((q) => q.question).join(' | '),
    );
  } else if (evalCase.onQuestion === 'fail') {
    add(
      'process',
      'does not ask a question',
      !asked,
      turn.questions.map((q) => q.question).join(' | '),
    );
  }
  const reply = normalize(turn.reply);
  for (const needle of expect.reply?.contains ?? []) {
    add('process', `reply mentions "${needle}"`, reply.includes(normalize(needle)));
  }
  for (const needle of expect.reply?.not_contains ?? []) {
    add('process', `reply does not mention "${needle}"`, !reply.includes(normalize(needle)));
  }
  if (expect.reply?.language) {
    const found = language(turn.reply);
    add(
      'process',
      `reply is in ${expect.reply.language}`,
      found === expect.reply.language,
      `detected ${found}`,
    );
  }
  if (expect.reply?.min_chars != null) {
    add(
      'process',
      `reply is at least ${expect.reply.min_chars} characters`,
      turn.reply.length >= expect.reply.min_chars,
      `${turn.reply.length} characters`,
    );
  }
  if (expect.max_seconds != null) {
    add(
      'process',
      `finishes within ${expect.max_seconds}s`,
      turn.seconds <= expect.max_seconds,
      `${turn.seconds}s`,
    );
  }
}

function checkHealth(turn: TurnResult, add: Add): void {
  add('health', 'turn finished', turn.finished, turn.error);
  add(
    'health',
    'no error in the reply',
    !turn.error && !USER_FACING_ERROR.test(turn.reply),
    turn.error ?? turn.reply.match(USER_FACING_ERROR)?.[0],
  );
  const outputs = turn.toolCalls.map((call) => call.output).join('\n');
  const hits = KNOWN_FAILURES.filter(([, pattern]) => pattern.test(outputs)).map(
    ([label]) => label,
  );
  add('health', 'no known sandbox failures', hits.length === 0, hits.join(', '));
  const failed = turn.attachments.filter((attachment) => attachment.error);
  if (turn.attachments.length) {
    add(
      'health',
      'delivered files download',
      failed.length === 0,
      failed.map((a) => `${a.filename}: ${a.error}`).join('; '),
    );
  }
  const unreadable = turn.files.filter((file) => !file.ok);
  if (turn.files.length) {
    add(
      'health',
      'delivered files open',
      unreadable.length === 0,
      unreadable.map((f) => `${f.name}: ${f.error}`).join('; '),
    );
  }
  add('process', 'no sandbox path in the reply', !/\/mnt\/data\/|\]\(sandbox:/.test(turn.reply));
}

export async function grade(
  turns: TurnResult[],
  evalCase: EvalCase,
  rendersDir: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const turn of turns) {
    const add: Add = (layer, label, ok, detail) =>
      checks.push({ layer, label, ok, ...(detail ? { detail } : {}), turn: turn.index });
    checkHealth(turn, add);
    const expect = evalCase.turns[turn.index]?.expect;
    if (!expect) {
      continue;
    }
    checkProcess(turn, expect, evalCase, add);
    await checkFiles(turn, expect, add, rendersDir);
  }
  return checks;
}
