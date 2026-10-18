export type Layer = 'health' | 'process' | 'file' | 'quality';

export type QuestionPolicy = 'first_option' | 'fail';

export type ParamValue = string | number | boolean;

export interface FileExpect {
  /** Regex the delivered file name must match. */
  name?: string;
  ext?: string | string[];
  contains?: string[];
  not_contains?: string[];
  min_pages?: number;
  max_pages?: number;
  slides?: number;
  min_slides?: number;
  max_slides?: number;
  sheets?: string[];
  min_formulas?: number;
  /** Fail on cached #REF!, #DIV/0!, #VALUE! … cells. Defaults to true for workbooks. */
  no_errors?: boolean;
  fonts?: string[];
  min_images?: number;
  min_width?: number;
  min_height?: number;
  /** A fixture whose paragraphs must survive an edit. */
  keeps_text_from?: string;
  /** Share of the fixture's paragraphs that must still be present (default 0.8). */
  keeps_ratio?: number;
}

export interface FilesExpect {
  count?: number;
  min?: number;
  max?: number;
  items?: FileExpect[];
}

export interface Expect {
  files?: FilesExpect;
  /** Skills the agent must load (by SKILL.md name). */
  skills?: string[];
  tools?: { include?: string[]; exclude?: string[]; max_calls?: number };
  /** Specialists (manifest ids) the master must hand off to. */
  handoff?: string[];
  no_handoff?: boolean;
  reply?: {
    contains?: string[];
    not_contains?: string[];
    language?: 'bn' | 'en';
    min_chars?: number;
  };
  /** true: the agent must ask; false: it must not. Unset: either is fine. */
  asks?: boolean;
  max_seconds?: number;
}

export interface Turn {
  text: string;
  attach: string[];
  expect?: Expect;
}

export interface EvalCase {
  id: string;
  title: string;
  category: string;
  tags: string[];
  repeat: number;
  timeoutSeconds: number;
  turns: Turn[];
  rubric?: string;
  minScore: number;
  answers: string[];
  onQuestion: QuestionPolicy;
  source: string;
}

export interface AgentOverride {
  provider?: string;
  model?: string;
  instructions?: string;
  instructions_file?: string;
  instructions_append?: string;
  tools?: string[];
  model_parameters?: Record<string, ParamValue>;
  skills_enabled?: boolean;
}

export interface Variant {
  id: string;
  label: string;
  /** Absolute path of the agent manifest the variant starts from. */
  manifest: string;
  /** Absolute path of the deployment skills directory. */
  skills: string;
  master?: AgentOverride;
  specialists?: Record<string, AgentOverride>;
  drop_specialists?: string[];
  source: string;
}

/** A variant once its agents exist: the ids and spec the runner sends. */
export interface Deployed {
  variant: Variant;
  spec: string;
  agentId: string;
  /** Manifest specialist id → id in the eval database. */
  specialistIds: Record<string, string>;
}

export interface Account {
  email: string;
  password: string;
}

export interface Session {
  token: string;
  userId: string;
  email: string;
}

export interface ToolCall {
  name: string;
  args: string;
  output: string;
}

export interface Question {
  id?: string;
  question: string;
  options: string[];
  answer: string;
}

export interface Attachment {
  fileId?: string;
  filename: string;
  type?: string;
  path?: string;
  error?: string;
}

export interface Sheet {
  name: string;
  dims: string;
  cells: number;
  formulas: number;
  errors: number;
  uncached: number;
  charts: number;
}

export interface FileReport {
  path: string;
  name: string;
  kind: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image' | 'other';
  bytes: number;
  ok: boolean;
  error?: string;
  text: string;
  paragraphs: string[];
  fonts: string[];
  /** docx: "style name: paragraph start" per paragraph, for the judge. */
  outline?: string[];
  pages?: number;
  slides?: number;
  slide_titles?: string[];
  images?: number;
  sheets?: Sheet[];
  width?: number;
  height?: number;
  blank?: boolean;
  renders: string[];
  render_error?: string;
}

export interface TurnResult {
  index: number;
  prompt: string;
  conversationId: string;
  messageId?: string;
  seconds: number;
  finished: boolean;
  error?: string;
  reply: string;
  toolCalls: ToolCall[];
  skills: string[];
  handoffs: string[];
  questions: Question[];
  attachments: Attachment[];
  files: FileReport[];
}

export interface Check {
  layer: Layer;
  label: string;
  ok: boolean;
  detail?: string;
  turn?: number;
}

export interface Judgement {
  model: string;
  score: number;
  pass: boolean;
  summary: string;
  strengths: string[];
  problems: string[];
  costUsd?: number;
  error?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  models: string[];
}

export interface RunResult {
  key: string;
  caseId: string;
  variantId: string;
  attempt: number;
  category: string;
  startedAt: string;
  seconds: number;
  turns: TurnResult[];
  checks: Check[];
  judge?: Judgement;
  usage?: Usage;
  pass: boolean;
  dir: string;
}

export interface Aggregate {
  variantId: string;
  caseId: string;
  runs: number;
  passed: number;
  passRate: number;
  meanScore?: number;
  meanSeconds: number;
  meanCostUsd?: number;
}

export interface Regression {
  variantId: string;
  caseId: string;
  reason: string;
}

export interface Report {
  runId: string;
  startedAt: string;
  finishedAt: string;
  app: { root: string; branch: string; commit: string; sandbox?: string };
  options: { repeat?: number; concurrency: number; judge: string | null; mode: 'local' | 'remote' };
  variants: { id: string; label: string; agentId: string; models: string[]; skills: string }[];
  cases: { id: string; title: string; category: string; turns: number }[];
  runs: RunResult[];
  aggregates: Aggregate[];
  regressions: Regression[];
  serverErrors: string[];
  judgeCostUsd: number;
}
