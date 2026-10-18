import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentOverride, EvalCase, Expect, QuestionPolicy, Turn, Variant } from './types.ts';

export const HERE = path.dirname(new URL(import.meta.url).pathname);

const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_MIN_SCORE = 3;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface RawTurn {
  text?: string;
  prompt?: string;
  attach?: string[];
  expect?: Expect;
}

interface RawCase extends RawTurn {
  id?: string;
  title?: string;
  category?: string;
  tags?: string[];
  repeat?: number;
  timeout_seconds?: number;
  turns?: RawTurn[];
  rubric?: string;
  min_score?: number;
  answers?: string[];
  on_question?: QuestionPolicy;
}

interface RawVariant {
  id?: string;
  label?: string;
  manifest?: string;
  skills?: string;
  master?: AgentOverride;
  specialists?: Record<string, AgentOverride>;
  drop_specialists?: string[];
}

const readYaml = <T>(file: string): T => yaml.load(fs.readFileSync(file, 'utf8')) as T;

const yamlFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
        .map((name) => path.join(dir, name))
    : [];

const stem = (file: string): string => path.basename(file).replace(/\.ya?ml$/, '');

const mustExist = (file: string, owner: string): string => {
  if (!fs.existsSync(file)) {
    throw new Error(`${owner}: ${file} does not exist`);
  }
  return file;
};

/** `app:` paths resolve against the app checkout, anything else against the file that names them. */
export function resolvePath(value: string, appRoot: string, from: string): string {
  if (value.startsWith('app:')) {
    return path.resolve(appRoot, value.slice(4));
  }
  return path.resolve(path.dirname(from), value);
}

function resolveExpect(expect: Expect | undefined, owner: string): Expect | undefined {
  const items = expect?.files?.items;
  if (!expect || !items) {
    return expect;
  }
  const resolved = items.map((item) =>
    item.keeps_text_from
      ? { ...item, keeps_text_from: mustExist(path.resolve(HERE, item.keeps_text_from), owner) }
      : item,
  );
  return { ...expect, files: { ...expect.files, items: resolved } };
}

function toTurn(raw: RawTurn, owner: string): Turn {
  const text = raw.text ?? raw.prompt;
  if (!text) {
    throw new Error(`${owner}: every turn needs text`);
  }
  const attach = (raw.attach ?? []).map((file) => mustExist(path.resolve(HERE, file), owner));
  return { text, attach, expect: resolveExpect(raw.expect, owner) };
}

function toCase(raw: RawCase, source: string): EvalCase {
  const id = raw.id ?? stem(source);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${source}: id "${id}" must be lowercase letters, digits and dashes`);
  }
  const rawTurns: RawTurn[] = raw.turns ?? [{ text: raw.text ?? raw.prompt, attach: raw.attach }];
  if (rawTurns.length === 0) {
    throw new Error(`${source}: no turns`);
  }
  const turns = rawTurns.map((turn) => toTurn(turn, source));
  const last = turns[turns.length - 1];
  if (raw.expect) {
    last.expect = resolveExpect({ ...last.expect, ...raw.expect }, source);
  }
  return {
    id,
    title: raw.title ?? id,
    category: raw.category ?? 'general',
    tags: raw.tags ?? [],
    repeat: raw.repeat ?? 1,
    timeoutSeconds: raw.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    turns,
    rubric: raw.rubric,
    minScore: raw.min_score ?? DEFAULT_MIN_SCORE,
    answers: raw.answers ?? [],
    onQuestion: raw.on_question ?? 'first_option',
    source,
  };
}

/** Reads `instructions_file` (relative to the variant file) into `instructions`. */
function withInstructions(override: AgentOverride, source: string): AgentOverride {
  const { instructions_file, ...rest } = override;
  if (!instructions_file) {
    return rest;
  }
  const file = mustExist(path.resolve(path.dirname(source), instructions_file), source);
  return { ...rest, instructions: fs.readFileSync(file, 'utf8') };
}

function toVariant(raw: RawVariant, source: string, appRoot: string): Variant {
  const id = raw.id ?? stem(source);
  if (!/^[a-z0-9_]{1,16}$/.test(id)) {
    throw new Error(
      `${source}: variant id "${id}" must be 1-16 of [a-z0-9_] (it becomes part of agent ids)`,
    );
  }
  const master = raw.master && withInstructions(raw.master, source);
  const specialists = Object.fromEntries(
    Object.entries(raw.specialists ?? {}).map(([specId, override]) => [
      specId,
      withInstructions(override, source),
    ]),
  );
  return {
    id,
    label: raw.label ?? id,
    manifest: mustExist(
      resolvePath(raw.manifest ?? 'app:config/phase-one-office-agents.yaml', appRoot, source),
      source,
    ),
    skills: mustExist(resolvePath(raw.skills ?? 'app:skill', appRoot, source), source),
    master,
    specialists,
    drop_specialists: raw.drop_specialists ?? [],
    source,
  };
}

/** Matches ids exactly, or as a prefix when the filter ends with `*`. */
const selected = (id: string, filter: string[] | undefined): boolean =>
  !filter?.length ||
  filter.some((f) => (f.endsWith('*') ? id.startsWith(f.slice(0, -1)) : f === id));

export function loadCases(filter?: string[]): EvalCase[] {
  const cases = yamlFiles(path.join(HERE, 'cases')).map((file) =>
    toCase(readYaml<RawCase>(file), file),
  );
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) {
      throw new Error(`duplicate case id ${item.id}`);
    }
    ids.add(item.id);
  }
  return cases.filter((item) => selected(item.id, filter) || selected(item.category, filter));
}

export function loadVariants(appRoot: string, filter?: string[]): Variant[] {
  return yamlFiles(path.join(HERE, 'variants'))
    .map((file) => toVariant(readYaml<RawVariant>(file), file, appRoot))
    .filter((variant) => selected(variant.id, filter));
}
