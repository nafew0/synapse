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

/** Marks on a page that are not printed lines. Gemini answers boxes as [ymin, xmin, ymax, xmax]. */
export const OBJECT_KINDS = [
  'logo',
  'photo',
  'signature',
  'initials',
  'stamp',
  'handwriting',
  'picture',
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Found objects added only where the reader has nothing of its own over this share of them. */
const COVERED_SHARE = 0.3;
/** Kinds that sit inside text blocks: added only where no element at all covers them. */
const HAND_KINDS: ReadonlySet<string> = new Set(['signature', 'initials', 'handwriting']);
const KIND_SET: ReadonlySet<string> = new Set(OBJECT_KINDS);
const PICTURE_TYPES: ReadonlySet<string> = new Set(['Image', 'Picture', 'Figure']);
const GRID = 1000;

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
  /** Pictures the structure call saw on the pages, and those of them added as elements. */
  foundObjects: number;
  addedObjects: number;
}

export interface PageObject {
  page: number;
  kind: ObjectKind;
  /** x0, y0, x1, y1 as fractions of the page. */
  box: [number, number, number, number];
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

For each line also say whether it is printed bold: its letters clearly thicker and darker than the
body text on this page. Headings, titles and a signer's name are often bold; paragraphs are not.

objects: every mark on the page that is not one of the listed printed lines, each with its kind and
box_2d as [ymin, xmin, ymax, xmax] on a 0-1000 scale of the page:
- logo: an emblem or crest (the emblem itself, not the words printed under it)
- photo: a photograph or portrait
- signature: a handwritten signature, with the handwritten date written beside it
- initials: a short handwritten mark or initials
- stamp: a rubber stamp or seal, even a faint or coloured one
- handwriting: any other handwritten note, number or correction
- picture: any other drawing or picture
Fit each box tightly around its ink and list each object once. Look over the whole page, including
the margins and the bottom.

side_by_side: pairs [left id, right id] of lines printed beside each other on the same rows.
reading_order: every line id in the order a person reads the page.
Answer in JSON.

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
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: STRUCTURE_ROLES },
          bold: { type: 'boolean' },
        },
        required: ['id', 'role', 'bold'],
        additionalProperties: false,
      },
    },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: OBJECT_KINDS },
          box_2d: { type: 'array', items: { type: 'integer' } },
        },
        required: ['kind', 'box_2d'],
        additionalProperties: false,
      },
    },
    side_by_side: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    reading_order: { type: 'array', items: { type: 'string' } },
  },
  required: ['blocks', 'objects', 'side_by_side', 'reading_order'],
  additionalProperties: false,
};

interface StructureAnswer {
  blocks?: { id?: unknown; role?: unknown; bold?: unknown }[];
  objects?: { kind?: unknown; box_2d?: unknown }[];
}

interface PageAnswer {
  roles: Map<string, StructureRole>;
  bold: Map<string, boolean>;
  objects: PageObject[];
  cost: number;
}

/** A Gemini box_2d, [ymin, xmin, ymax, xmax] on the 0-1000 grid, as page fractions; null if malformed. */
function objectBox(value: unknown): PageObject['box'] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number')) {
    return null;
  }
  const [ymin, xmin, ymax, xmax] = (value as number[]).map(
    (v) => Math.min(Math.max(v, 0), GRID) / GRID,
  );
  return xmax > xmin && ymax > ymin ? [xmin, ymin, xmax, ymax] : null;
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
  page: number,
): Promise<PageAnswer> {
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
  const bold = new Map<string, boolean>();
  for (const block of answer.blocks ?? []) {
    if (typeof block.id !== 'string' || !sent.has(block.id)) {
      continue;
    }
    if (typeof block.role === 'string' && ROLE_SET.has(block.role)) {
      roles.set(block.id, block.role as StructureRole);
    }
    if (typeof block.bold === 'boolean') {
      bold.set(block.id, block.bold);
    }
  }
  const objects: PageObject[] = [];
  for (const object of answer.objects ?? []) {
    const box = objectBox(object.box_2d);
    if (box && typeof object.kind === 'string' && KIND_SET.has(object.kind)) {
      objects.push({ page, kind: object.kind as ObjectKind, box });
    }
  }
  return { roles, bold, objects, cost: data.usage?.cost ?? 0 };
}

/** The elements with `metadata.line_roles` and `line_bold`, one entry per text line, where any line got one. */
function withLineStyles(
  elements: UnstructuredElement[],
  roles: Map<string, StructureRole>,
  bold: Map<string, boolean>,
): UnstructuredElement[] {
  return elements.map((element, index) => {
    const ids = linesOf(element).map((_, line) => `e${index}.${line}`);
    const lineRoles = ids.map((id) => roles.get(id) ?? null);
    const lineBold = ids.map((id) => bold.get(id) ?? null);
    const metadata = { ...element.metadata };
    if (lineRoles.some(Boolean)) {
      metadata.line_roles = lineRoles;
    }
    if (lineBold.some((value) => value !== null)) {
      metadata.line_bold = lineBold;
    }
    return metadata.line_roles || metadata.line_bold ? { ...element, metadata } : element;
  });
}

/** Share of `inner` that `outer` covers; boxes as page fractions. */
function coveredShare(inner: PageObject['box'], outer: PageObject['box']): number {
  const width = Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]);
  const height = Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]);
  const area = (inner[2] - inner[0]) * (inner[3] - inner[1]);
  return width > 0 && height > 0 && area > 0 ? (width * height) / area : 0;
}

/**
 * Adds the pictures the reader dropped, each before the first element on its page that starts
 * below it, so the rebuild meets it where a reader would. A stamp, logo or photo is kept unless a
 * picture the reader found already covers it; handwriting and signatures sit inside text blocks,
 * so they are kept only where no element covers them at all.
 */
export function withFoundObjects(
  elements: UnstructuredElement[],
  objects: PageObject[],
): { elements: UnstructuredElement[]; added: number } {
  const placed = elements.map((element) => ({
    element,
    page: element.metadata?.page_number ?? 1,
    box: fractionBox(element),
  }));
  const kept = objects.filter((object) =>
    placed.every(({ element, page, box }) => {
      if (page !== object.page || !box) {
        return true;
      }
      const counts = HAND_KINDS.has(object.kind) || PICTURE_TYPES.has(element.type);
      return !counts || coveredShare(object.box, box) < COVERED_SHARE;
    }),
  );
  if (kept.length === 0) {
    return { elements, added: 0 };
  }
  const result = [...elements];
  const ordered = [...kept].sort((a, b) => b.page - a.page || b.box[1] - a.box[1]);
  for (const object of ordered) {
    const size = placed.find(
      (p) => p.page === object.page && p.element.metadata?.coordinates?.layout_width,
    );
    const coordinates = size?.element.metadata?.coordinates;
    if (!coordinates?.layout_width || !coordinates.layout_height) {
      continue;
    }
    const width = coordinates.layout_width;
    const height = coordinates.layout_height;
    const [x0, y0, x1, y1] = object.box;
    const added: UnstructuredElement = {
      type: 'Image',
      text: '',
      metadata: {
        page_number: object.page,
        source: 'vision',
        vision_kind: object.kind,
        coordinates: {
          points: [
            [x0 * width, y0 * height],
            [x0 * width, y1 * height],
            [x1 * width, y1 * height],
            [x1 * width, y0 * height],
          ],
          system: coordinates.system ?? 'PixelSpace',
          layout_width: width,
          layout_height: height,
        },
      },
    };
    const at = result.findIndex((element) => {
      const page = element.metadata?.page_number ?? 1;
      const box = fractionBox(element);
      return page > object.page || (page === object.page && box !== null && box[1] > y0);
    });
    result.splice(at === -1 ? result.length : at, 0, added);
  }
  return { elements: result, added: kept.length };
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
          return { page, ...(await askPage(await render(page), lines, options, page)) };
        } catch (error) {
          logger.warn(`[read_document] structure call failed on page ${page}`, error);
          return { page, roles: null, bold: null, objects: [], cost: 0 };
        }
      }),
    ),
  );
  const roles = new Map<string, StructureRole>();
  const bold = new Map<string, boolean>();
  for (const answer of answers) {
    answer.roles?.forEach((role, id) => roles.set(id, role));
    answer.bold?.forEach((value, id) => bold.set(id, value));
  }
  const found = withFoundObjects(
    withLineStyles(elements, roles, bold),
    answers.flatMap((answer) => answer.objects),
  );
  return {
    elements: found.elements,
    cost: answers.reduce((sum, answer) => sum + answer.cost, 0),
    failedPages: answers.filter((answer) => answer.roles === null).map((answer) => answer.page),
    foundObjects: answers.reduce((sum, answer) => sum + answer.objects.length, 0),
    addedObjects: found.added,
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
      `[read_document] structure call: ${options.model}, ${result.cost.toFixed(4)} USD, ${result.foundObjects} pictures seen, ${result.addedObjects} added${failed}`,
    );
    return result.elements;
  };
}
