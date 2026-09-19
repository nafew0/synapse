#!/usr/bin/env node
/**
 * Smoke-test office document generation and editing against a running stack.
 *
 * Run after a change to the office skills, the office agents, or the sandbox
 * plumbing, to confirm a deck can still be produced and edited without any of
 * the failures that have reached users before. It drives the real chat API, so
 * it exercises the agent, the skills and the code sandbox exactly as a person
 * would — no browser, no test framework.
 *
 *   OFFICE_EMAIL=you@example.com OFFICE_PASSWORD=... node scripts/check-office-pipeline.mjs
 *
 * Options:
 *   --base   API origin            (default http://localhost:3080)
 *   --only   generate | edit       (default: both)
 *   --keep   leave the conversations in the sidebar instead of noting them
 *
 * Exits 0 when every check passes, 1 otherwise. Takes several minutes and
 * spends real model and sandbox budget.
 */
import { randomUUID } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', process.env.OFFICE_BASE_URL ?? 'http://localhost:3080');
const ONLY = arg('only', null);
const EMAIL = process.env.OFFICE_EMAIL;
const PASSWORD = process.env.OFFICE_PASSWORD;

const GREEN = '\u001b[32m', RED = '\u001b[31m', DIM = '\u001b[2m', YEL = '\u001b[33m', OFF = '\u001b[0m';

/**
 * Failures that have reached users from this pipeline. Each was traced to a
 * defect and fixed; any reappearing is a regression, not noise.
 */
const KNOWN_FAILURES = [
  ['relationships lost',        /no relationship of type/],
  ['package unreadable',        /source file could not be loaded|PackageNotFoundError/],
  ['scratch script gone',       /Cannot find module|No such file or directory/],
  ['rebuild never landed',      /mv: cannot stat/],
  ['sandbox rejected the call', /Conflicting input destinations|Execution error/],
  ['file missing in sandbox',   /does not exist in the sandbox/],
  ['javaldx noise',             /javaldx/i],
];

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set OFFICE_EMAIL and OFFICE_PASSWORD.');
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('login returned no token');
  return token;
}

/**
 * Send a prompt and wait for the turn to finish.
 *
 * The POST is an admission: it answers with JSON naming the conversation and
 * returns immediately, while the generation runs on. Completion is therefore
 * read from the persisted message -- `unfinished` clearing on an assistant
 * message that has content -- because a deck is built over many tool calls and
 * every intermediate state is persisted along the way.
 */
async function ask(token, prompt, conversationId) {
  const body = {
    text: prompt,
    sender: 'User',
    clientTimestamp: new Date().toISOString().slice(0, 19),
    isCreatedByUser: true,
    parentMessageId: conversationId ? undefined : '00000000-0000-0000-0000-000000000000',
    messageId: randomUUID(),
    error: false,
    endpoint: 'agents',
    spec: 'office-assistant',
    agent_id: 'agent_office_assistant',
    key: new Date().toISOString(),
    isTemporary: false,
    isRegenerate: false,
    isContinued: false,
    ephemeralAgent: { mcp: [], web_search: false, file_search: false, execute_code: false, memory: false, artifacts: '' },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clientRequestId: randomUUID(),
    generationProtocolVersion: 2,
    ...(conversationId ? { conversationId } : {}),
  };

  const res = await fetch(`${BASE}/api/agents/chat/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);

  const start = await res.json().catch(() => ({}));
  const id = start.conversationId ?? conversationId;
  if (!id || id === 'new') {
    throw new Error(`admission did not name a conversation: ${JSON.stringify(start).slice(0, 200)}`);
  }

  const began = Date.now();
  const deadlineMs = Number(process.env.OFFICE_TIMEOUT_MS ?? 15 * 60 * 1000);
  for (;;) {
    const elapsed = Date.now() - began;
    if (elapsed > deadlineMs) {
      throw new Error(`turn did not finish within ${Math.round(deadlineMs / 1000)}s (/c/${id})`);
    }
    const message = await lastAssistantMessage(token, id);
    if (message && !message.unfinished && (message.content?.length ?? 0) > 0) {
      process.stdout.write('\r' + ' '.repeat(64) + '\r');
      return { conversationId: id, seconds: Math.round(elapsed / 1000) };
    }
    const tools = (message?.content ?? []).filter((c) => c.type === 'tool_call').length;
    process.stdout.write(`\r  ${DIM}working… ${Math.round(elapsed / 1000)}s, ${tools} tool call(s)${OFF}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function lastAssistantMessage(token, conversationId) {
  const res = await fetch(`${BASE}/api/messages/${encodeURIComponent(conversationId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  const messages = await res.json();
  const assistant = messages.filter((m) => !m.isCreatedByUser);
  return assistant[assistant.length - 1] ?? null;
}

const checks = [];
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${OFF}  ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`);
};

function inspect(message, { expectText } = {}) {
  const transcript = JSON.stringify(message?.content ?? []);
  const attachments = message?.attachments ?? [];
  const names = attachments.map((a) => a.filename ?? '?');
  const prose = (message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n') || message?.text || '';

  const hits = KNOWN_FAILURES.filter(([, re]) => re.test(transcript)).map(([label]) => label);
  check(hits.length === 0, 'no known sandbox failures', hits.length ? hits.join(', ') : '');

  check(attachments.length === 1, 'exactly one file delivered', names.join(', ') || 'none');
  check(names.every((n) => /\.(pptx|docx|xlsx|pdf)$/i.test(n)), 'deliverable is a document', names.join(', '));
  check(!names.some((n) => /_fixed|_v\d|_final/i.test(n)), 'no superseded version left behind', names.join(', '));
  check(!names.some((n) => n.includes('/')), 'no working file delivered', names.filter((n) => n.includes('/')).join(', '));
  check(!/\]\(sandbox:/.test(prose), 'no download link in the reply');
  check(!/\/mnt\/data\//.test(prose), 'no sandbox path in the reply');
  if (expectText) {
    check(transcript.includes(expectText), `the edit was applied`, `looked for "${expectText}"`);
  }
}

async function main() {
  console.log(`${DIM}base ${BASE}${OFF}\n`);
  const token = await login();

  if (ONLY !== 'edit') {
    console.log('generate a deck');
    const { conversationId, seconds } = await ask(
      token,
      'Create a 5-slide pptx on desk ergonomics for office staff. Check it visually and fix anything wrong before delivering.',
    );
    console.log(`  ${DIM}${seconds}s  /c/${conversationId}${OFF}`);
    inspect(await lastAssistantMessage(token, conversationId));
    console.log('');
  }

  if (ONLY !== 'generate') {
    console.log('generate then edit');
    const { conversationId, seconds } = await ask(
      token,
      'Create a 4-slide pptx on clean desk policy for office staff, then edit it: retitle slide 1 to ' +
        '"Clear Desk, Clear Mind" and add a closing slide. Verify it visually and give me the deck.',
    );
    console.log(`  ${DIM}${seconds}s  /c/${conversationId}${OFF}`);
    inspect(await lastAssistantMessage(token, conversationId), { expectText: 'Clear Desk, Clear Mind' });
    console.log('');
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`${RED}${failed.length} of ${checks.length} checks failed${OFF}`);
    process.exit(1);
  }
  console.log(`${GREEN}all ${checks.length} checks passed${OFF}`);
}

main().catch((error) => {
  console.error(`\n${RED}${error.message}${OFF}`);
  if (/ECONNREFUSED/.test(error.message)) {
    console.error(`${YEL}Is the backend running? npm run backend:dev${OFF}`);
  }
  process.exit(1);
});
