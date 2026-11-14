/** How the extension's model endpoint is set up: one model Synapse chooses, a server-side key, per-user limits. */
export interface ExtensionConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Input plus output tokens one user may spend in a UTC day. */
  dailyTokens: number;
  maxOutputTokens: number;
  /** The most steps a task may take; the extension applies it. */
  maxSteps: number;
  /**
   * The model's context window. The extension cannot know it: the model name it sends is always `synapse`, so without
   * this it would guess from its own catalogue and shorten a task's steps far too early.
   */
  contextTokens: number;
  /** Whether the model reads screenshots. */
  vision: boolean;
  /**
   * How hard the model thinks at each step. A browser task is mostly mechanical — look, click, type — and each step
   * waits on this, so `none` is the default; `low` and above buy judgement at seconds a step.
   */
  reasoning: 'none' | 'low' | 'medium' | 'high';
  /**
   * Tools to leave out of a run. Every tool's definition is sent on every step — about 8.5k tokens in all — so one
   * a pilot never needs costs time on each of them. `snapshot` and `done` are always kept.
   */
  disabledTools: string[];
}

const EFFORTS = ['none', 'low', 'medium', 'high'] as const;

/** Left out unless an institution asks for them: hovering, and the agent's own file tools. */
const DEFAULT_DISABLED = ['hover', 'save_file', 'read_attachment'];

const list = (value: string | undefined, fallback: string[]): string[] => {
  const given = value
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return given === undefined ? fallback : given;
};

const effort = (value: string | undefined): ExtensionConfig['reasoning'] => {
  const given = value?.trim().toLowerCase();
  return EFFORTS.find((e) => e === given) ?? 'none';
};

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export function getExtensionConfig(env: NodeJS.ProcessEnv = process.env): ExtensionConfig {
  return {
    model: env.BROWSER_EXTENSION_MODEL?.trim() ?? '',
    apiKey: env.BROWSER_EXTENSION_API_KEY?.trim() || env.OPENROUTER_KEY?.trim() || '',
    baseUrl: (env.BROWSER_EXTENSION_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(
      /\/+$/,
      '',
    ),
    dailyTokens: positive(env.BROWSER_EXTENSION_DAILY_TOKENS, 2_000_000),
    maxOutputTokens: positive(env.BROWSER_EXTENSION_MAX_OUTPUT_TOKENS, 8_192),
    maxSteps: positive(env.BROWSER_EXTENSION_MAX_STEPS, 50),
    contextTokens: positive(env.BROWSER_EXTENSION_CONTEXT_TOKENS, 128_000),
    vision: env.BROWSER_EXTENSION_VISION?.trim().toLowerCase() !== 'false',
    reasoning: effort(env.BROWSER_EXTENSION_REASONING),
    disabledTools: list(env.BROWSER_EXTENSION_DISABLED_TOOLS, DEFAULT_DISABLED),
  };
}

/** The endpoint is off until a model and a key are set. */
export const isExtensionConfigured = (config: ExtensionConfig = getExtensionConfig()): boolean =>
  Boolean(config.model && config.apiKey);
