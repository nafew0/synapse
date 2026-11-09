import sharp from 'sharp';
import { logger } from '@librechat/data-schemas';
import { extractEnvVariable } from 'librechat-data-provider';
import type { TDocumentOcrStructureConfig } from 'librechat-data-provider';
import type { UnstructuredElement } from './types';
import type { DocumentFile } from './tool';
import { createAxiosInstance } from '~/utils/axios';
import { createLimiter } from './client';

const axios = createAxiosInstance();

/**
 * What a line on a scanned page is. The rebuild uses these only to say no: a line the model does
 * not call a signature is never made one, so a page number or an addressee on the right stays text.
 */
export const STRUCTURE_ROLES = [
  'letterhead',
  'memo',
  'date',
  'title',
  'body',
  'list',
  'table',
  'signature',
  'addressee',
  'copy_list',
  'stamp',
  'handwriting',
  'header',
  'footer',
  'page_number',
  'other',
] as const;

export type StructureRole = (typeof STRUCTURE_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(STRUCTURE_ROLES);
const IMAGE_SIDE = 1600;
const JPEG_QUALITY = 85;
const TEXT_CHARS = 80;
const PAGE_CONCURRENCY = 4;

export interface StructureOptions {
  /** An OpenAI-compatible base URL, such as OpenRouter's. */
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface PageLine {
  /** `e<element index>.<line index>` */
  id: string;
  /** x0, y0, x1, y1 as fractions of the page. Lines of one element share its box. */
  box: [number, number, number, number];
  text: string;
}

/** A page as a JPEG at most IMAGE_SIDE px on its long side. */
export type RenderPage = (page: number) => Promise<Buffer>;

export interface LabelledReading {
  elements: UnstructuredElement[];
  /** OpenRouter's reported cost in USD. */
  cost: number;
  /** Pages left without roles because they could not be drawn or the call failed. */
  failedPages: number[];
}

const PROMPT = `You are given one page of a scanned Bangladeshi government or university document and the
lines of text already read from it. Each line has an id, the box of the block it was read in as
fractions of the page (x0, y0, x1, y1; 0,0 is the top left; lines of one block share its box) and
the start of its text. Look at the page image and say what each line is. Do not read or return any text.

Roles:
- letterhead: the issuing office's name, address, phone, website at the top
- memo: the reference number line (স্মারক / সূত্র / Memo no.)
- date: a date line (তারিখ), including a Bangla and an English date stacked
- title: the document's heading, such as অফিস আদেশ or বিজ্ঞপ্তি
- body: running paragraphs
- list: numbered items in the body
- table: a ruled table
- signature: the signer's name, designation and office under a signature, and the line introducing it
- addressee: who the letter is sent to
- copy_list: the copy-to list (অনুলিপি) and its items
- stamp: a received or office stamp
- handwriting: handwritten notes or dates
- header / footer: running heads or feet repeated on pages
- page_number: a printed page number
- other: anything else

side_by_side: pairs [left id, right id] of lines printed beside each other on the same rows.
reading_order: every line id in the order a person reads the page.

Lines:
`;

/** The answer has no text field, so the model cannot write or change a word. */
const SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, role: { type: 'string', enum: STRUCTURE_ROLES } },
        required: ['id', 'role'],
        additionalProperties: false,
      },
    },
    side_by_side: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    reading_order: { type: 'array', items: { type: 'string' } },
  },
  required: ['blocks', 'side_by_side', 'reading_order'],
  additionalProperties: false,
};

interface StructureAnswer {
  blocks?: { id?: unknown; role?: unknown }[];
}

interface ChatReply {
  choices?: { message?: { content?: string | null } }[];
  usage?: { cost?: number };
}

const fraction = (value: number, whole: number): number =>
  Math.round((value / whole) * 1000) / 1000;

function fractionBox(element: UnstructuredElement): PageLine['box'] | null {
  const coordinates = element.metadata?.coordinates;
  const points = coordinates?.points;
  const width = coordinates?.layout_width;
  const height = coordinates?.layout_height;
  if (!points?.length || !width || !height) {
    return null;
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [
    fraction(Math.min(...xs), width),
    fraction(Math.min(...ys), height),
    fraction(Math.max(...xs), width),
    fraction(Math.max(...ys), height),
  ];
}

/** An element's text lines, as the sandbox rebuild splits them; a table is one line. */
function linesOf(element: UnstructuredElement): string[] {
  const lines = (element.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return element.type === 'Table' && lines.length > 0 ? [lines.join(' ')] : lines;
}

/**
 * The lines the structure call labels on one page: each element's text split at its line breaks,
 * ids `e<element index>.<line>`. Pages Synapse read from the PDF itself have no boxes and are left out.
 */
export function pageLines(elements: UnstructuredElement[], page: number): PageLine[] {
  return elements.flatMap((element, index) => {
    if ((element.metadata?.page_number ?? 1) !== page) {
      return [];
    }
    const box = fractionBox(element);
    if (!box) {
      return [];
    }
    return linesOf(element).map((text, line) => ({ id: `e${index}.${line}`, box, text }));
  });
}

/** Draws a photo or scanned image for the structure call. */
export function imageRenderer(buffer: Buffer): RenderPage {
  return () =>
    sharp(buffer)
      .resize({ width: IMAGE_SIDE, height: IMAGE_SIDE, fit: 'inside' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
}

interface PdfCanvas {
  canvas: { toBuffer: (type: 'image/png') => Buffer };
  context: unknown;
}

/** Draws PDF pages with pdf.js and @napi-rs/canvas; the document is opened once for all pages. */
export function pdfRenderer(buffer: Buffer): RenderPage {
  let opened: Promise<{
    getPage: (page: number) => Promise<{
      getViewport: (options: { scale: number }) => { width: number; height: number };
      render: (options: Record<string, unknown>) => { promise: Promise<void> };
      cleanup: () => void;
    }>;
    canvasFactory: { create: (width: number, height: number) => PdfCanvas };
  }>;
  const open = () => {
    // Imported inline so that Jest can test other routes without failing due to loading ESM
    opened ??= import('pdfjs-dist/legacy/build/pdf.mjs').then(
      ({ getDocument }) =>
        getDocument({ data: new Uint8Array(buffer) }).promise as unknown as Awaited<typeof opened>,
    );
    return opened;
  };
  return async (number) => {
    const pdf = await open();
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: IMAGE_SIDE / Math.max(base.width, base.height) });
    const { canvas, context } = pdf.canvasFactory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    page.cleanup();
    return sharp(canvas.toBuffer('image/png')).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  };
}

async function askPage(
  image: Buffer,
  lines: PageLine[],
  options: StructureOptions,
): Promise<{ roles: Map<string, StructureRole>; cost: number }> {
  const listing = lines
    .map((line) =>
      JSON.stringify({ id: line.id, box: line.box, text: line.text.slice(0, TEXT_CHARS) }),
    )
    .join('\n');
  const { data } = await axios.post<ChatReply>(
    `${options.apiUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: options.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT + listing },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` },
            },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'page_structure', strict: true, schema: SCHEMA },
      },
      usage: { include: true },
    },
    {
      timeout: options.timeoutMs,
      headers: { Authorization: `Bearer ${options.apiKey}` },
    },
  );
  const answer = JSON.parse(data.choices?.[0]?.message?.content ?? '') as StructureAnswer;
  const sent = new Set(lines.map((line) => line.id));
  const roles = new Map<string, StructureRole>();
  for (const block of answer.blocks ?? []) {
    if (typeof block.id === 'string' && sent.has(block.id) && typeof block.role === 'string') {
      if (ROLE_SET.has(block.role)) {
        roles.set(block.id, block.role as StructureRole);
      }
    }
  }
  return { roles, cost: data.usage?.cost ?? 0 };
}

/** The elements with `metadata.line_roles`, one entry per text line, where any line got a role. */
function withLineRoles(
  elements: UnstructuredElement[],
  roles: Map<string, StructureRole>,
): UnstructuredElement[] {
  return elements.map((element, index) => {
    const lineRoles = linesOf(element).map((_, line) => roles.get(`e${index}.${line}`) ?? null);
    if (!lineRoles.some(Boolean)) {
      return element;
    }
    return { ...element, metadata: { ...element.metadata, line_roles: lineRoles } };
  });
}

/**
 * Asks a vision model what each read line on each page is (plan Phase 2). Only roles come back,
 * never text. A page that cannot be drawn or answered keeps no roles, and the rebuild falls back
 * to its own rules there, so this never fails a read.
 */
export async function labelLines({
  elements,
  render,
  options,
}: {
  elements: UnstructuredElement[];
  render: RenderPage;
  options: StructureOptions;
}): Promise<LabelledReading> {
  const pages = [...new Set(elements.map((element) => element.metadata?.page_number ?? 1))]
    .map((page) => ({ page, lines: pageLines(elements, page) }))
    .filter(({ lines }) => lines.length > 0);
  const limit = createLimiter(PAGE_CONCURRENCY);
  const answers = await Promise.all(
    pages.map(({ page, lines }) =>
      limit(async () => {
        try {
          return { page, ...(await askPage(await render(page), lines, options)) };
        } catch (error) {
          logger.warn(`[read_document] structure call failed on page ${page}`, error);
          return { page, roles: null, cost: 0 };
        }
      }),
    ),
  );
  const roles = new Map<string, StructureRole>();
  for (const answer of answers) {
    answer.roles?.forEach((role, id) => roles.set(id, role));
  }
  return {
    elements: withLineRoles(elements, roles),
    cost: answers.reduce((sum, answer) => sum + answer.cost, 0),
    failedPages: answers.filter((answer) => answer.roles === null).map((answer) => answer.page),
  };
}

export const resolveStructureOptions = (config: TDocumentOcrStructureConfig): StructureOptions => ({
  apiUrl: extractEnvVariable(config.apiUrl),
  apiKey: extractEnvVariable(config.apiKey),
  model: config.model,
  timeoutMs: config.timeoutMs,
});

const isPdfFile = (file: DocumentFile): boolean =>
  file.type === 'application/pdf' || /\.pdf$/i.test(file.filename);

type Labeller = (
  file: DocumentFile,
  buffer: Buffer,
  elements: UnstructuredElement[],
) => Promise<UnstructuredElement[]>;

/** The read tool's `labelStructure`: draws the file's pages and labels their lines. */
export function createStructureLabeller(options: StructureOptions): Labeller {
  return async (file, buffer, elements) => {
    const render = isPdfFile(file) ? pdfRenderer(buffer) : imageRenderer(buffer);
    const result = await labelLines({ elements, render, options });
    const failed = result.failedPages.length
      ? `, no roles on pages ${result.failedPages.join(', ')}`
      : '';
    logger.info(
      `[read_document] structure call: ${options.model}, ${result.cost.toFixed(4)} USD${failed}`,
    );
    return result.elements;
  };
}
