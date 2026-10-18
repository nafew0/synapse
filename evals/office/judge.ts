import fs from 'node:fs';
import path from 'node:path';
import type { EvalCase, FileReport, Judgement, TurnResult } from './types.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_IMAGES = 10;
const REPLY_LIMIT = 4000;
const FILE_TEXT_LIMIT = 5000;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const SYSTEM = `You grade an office assistant's work for an automated evaluation.
You see what the user asked, the assistant's final reply, a structural summary of every file it
delivered, and rendered pages or generated images. Judge only what is in front of you.

Score 1-5:
5 = fully does what was asked, professional quality, nothing to fix
4 = does what was asked with minor flaws a user would accept
3 = usable but with clear flaws a user would need to fix
2 = partly does the task or has serious flaws
1 = fails the task, is wrong, or delivers nothing usable

Check: every requirement in the request and rubric; correctness of facts, numbers and formulas;
layout problems visible in the renders (overflowing or overlapping text, empty slides, unreadable
contrast, broken tables); whether an edit kept what it was not asked to change; whether the reply
is in the user's language and honestly describes what was delivered.

Renders come from the evaluator, not the assistant. When a file has no render, judge it from its
structure and text, and do not count the missing render against the assistant or treat its own
claims about checking the layout as false.

Answer with JSON only:
{"score": <1-5>, "summary": "<one sentence>", "strengths": ["..."], "problems": ["..."]}`;

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function describeFile(file: FileReport): string {
  const facts = [
    `kind ${file.kind}`,
    `${file.bytes} bytes`,
    file.slides != null
      ? `${file.slides} slides (titles: ${(file.slide_titles ?? []).join(' | ')})`
      : '',
    file.pages != null ? `${file.pages} pages` : '',
    file.sheets?.length
      ? `sheets: ${file.sheets.map((s) => `${s.name} ${s.dims} (${s.formulas} formulas, ${s.errors} errors, ${s.charts} charts)`).join('; ')}`
      : '',
    file.width != null ? `${file.width}×${file.height}px${file.blank ? ', blank' : ''}` : '',
    file.fonts.length ? `fonts: ${file.fonts.join(', ')}` : '',
    file.images != null ? `${file.images} embedded images` : '',
    file.ok ? '' : `UNREADABLE: ${file.error}`,
    file.render_error
      ? 'the evaluator could not render this file (not a fault of the assistant)'
      : '',
  ].filter(Boolean);
  const body = file.outline?.length ? file.outline.join('\n') : file.text;
  const label = file.outline?.length ? 'Paragraphs (style: text)' : 'Text';
  const text = body ? `\n${label}:\n${body.slice(0, FILE_TEXT_LIMIT)}` : '';
  return `### ${file.name}\n${facts.join('; ')}${text}`;
}

function imagePart(file: string): Part | undefined {
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) {
    return undefined;
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` },
  };
}

function buildPrompt(evalCase: EvalCase, turns: TurnResult[]): Part[] {
  const transcript = turns
    .map((turn) => {
      const attached = evalCase.turns[turn.index]?.attach.map((file) => path.basename(file)) ?? [];
      const questions = turn.questions.map(
        (q) => `  (assistant asked "${q.question}", answered "${q.answer}")`,
      );
      return [
        `## Turn ${turn.index + 1}`,
        `User: ${turn.prompt}`,
        attached.length ? `User attached: ${attached.join(', ')}` : '',
        ...questions,
        `Assistant reply:\n${turn.reply.slice(0, REPLY_LIMIT) || '(no text)'}`,
        turn.files.length
          ? `Delivered files:\n${turn.files.map(describeFile).join('\n\n')}`
          : 'Delivered files: none',
        turn.error ? `Turn error: ${turn.error}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  const rubric = evalCase.rubric ? `\n\n## Rubric for this case\n${evalCase.rubric}` : '';
  const renders = turns
    .flatMap((turn) => turn.files.flatMap((file) => file.renders))
    .slice(-MAX_IMAGES);
  const images = renders.map(imagePart).filter((part): part is Part => part != null);
  const note = images.length
    ? `\n\nThe ${images.length} image(s) below are the rendered deliverables, in order.`
    : '';
  return [
    { type: 'text', text: `# Case: ${evalCase.title}\n\n${transcript}${rubric}${note}` },
    ...images,
  ];
}

function parse(content: string): {
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
} {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) {
    throw new Error(`the judge returned no JSON: ${content.slice(0, 200)}`);
  }
  const value = JSON.parse(json) as {
    score?: number;
    summary?: string;
    strengths?: string[];
    problems?: string[];
  };
  const score = Number(value.score);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error(`the judge returned an invalid score: ${value.score}`);
  }
  return {
    score,
    summary: value.summary ?? '',
    strengths: value.strengths ?? [],
    problems: value.problems ?? [],
  };
}

export async function judge(
  evalCase: EvalCase,
  turns: TurnResult[],
  model: string,
  apiKey: string,
): Promise<Judgement> {
  const base = { model, score: 0, pass: false, summary: '', strengths: [], problems: [] };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        usage: { include: true },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(evalCase, turns) },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json()) as ChatResponse;
    if (!res.ok || body.error) {
      throw new Error(`${res.status} ${body.error?.message ?? ''}`.trim());
    }
    const verdict = parse(body.choices?.[0]?.message?.content ?? '');
    return {
      ...base,
      ...verdict,
      pass: verdict.score >= evalCase.minScore,
      costUsd: body.usage?.cost,
    };
  } catch (error) {
    return { ...base, error: `judge failed: ${(error as Error).message}` };
  }
}
