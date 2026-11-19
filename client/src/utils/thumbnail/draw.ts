import type { Paragraph, Picture } from './word';
import type { Sheet } from './sheet';

/** Pixel width of every drawn preview: twice the 240px hover preview, for high-density screens. */
export const PREVIEW_WIDTH = 480;

/**
 * These are pictures of paper, so they use paper colors rather than theme roles: a dark theme
 * still shows a white page, the way a PDF page or a slide picture does.
 */
const PAPER = '#ffffff';
const INK = '#1f2328';
const RULE = '#d6dae0';
const BAND = '#f2f4f7';
const MUTED = '#6b7280';
const FONT = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Bengali', sans-serif";
const QUALITY = 0.85;

const PAGE_HEIGHT = 600;
/** Pixels per point: about twice print size, so text stays readable in the 240px preview. */
const PAGE_SCALE = 1.6;
const PAGE_MARGIN = 28;

const SHEET_HEIGHT = 360;
const ROW_HEIGHT = 24;
const HEADER_WIDTH = 34;
const CELL_PADDING = 6;
const MIN_COLUMN = 44;
const MAX_COLUMN = 150;
const CELL_FONT = `13px ${FONT}`;

const createCanvas = (height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_WIDTH;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = 'top';
  return { canvas, context };
};

/** Splits a word wider than the line into pieces that fit. */
const breakWord = (context: CanvasRenderingContext2D, word: string, width: number): string[] => {
  const pieces: string[] = [];
  let piece = '';
  for (const char of Array.from(word)) {
    if (piece && context.measureText(piece + char).width > width) {
      pieces.push(piece);
      piece = '';
    }
    piece += char;
  }
  return piece ? [...pieces, piece] : pieces;
};

const wrap = (context: CanvasRenderingContext2D, text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= width) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    const pieces = breakWord(context, word, width);
    line = pieces.pop() ?? '';
    lines.push(...pieces);
  }
  return line ? [...lines, line] : lines;
};

const alignedX = (align: Paragraph['align'], width: number) => {
  if (align === 'center') {
    return PREVIEW_WIDTH / 2;
  }
  return align === 'right' ? PAGE_MARGIN + width : PAGE_MARGIN;
};

/**
 * The opening of a Word document as a page, set larger than print so a small preview can be read.
 * Lines wrap to the preview's width rather than the document's, so the layout is approximate.
 */
export function drawPage(paragraphs: Paragraph[]): string | null {
  const surface = createCanvas(PAGE_HEIGHT);
  if (!surface) {
    return null;
  }
  const { canvas, context } = surface;
  const width = PREVIEW_WIDTH - PAGE_MARGIN * 2;
  context.fillStyle = INK;

  let y = PAGE_MARGIN;
  for (const paragraph of paragraphs) {
    const size = paragraph.size * PAGE_SCALE;
    if (!paragraph.text) {
      y += size * 0.6;
      continue;
    }
    context.font = `${paragraph.bold ? 600 : 400} ${size}px ${FONT}`;
    context.textAlign = paragraph.align;
    const x = alignedX(paragraph.align, width);
    for (const line of wrap(context, paragraph.text, width)) {
      context.fillText(line, x, y);
      y += size * 1.3;
    }
    y += size * 0.45;
    if (y >= PAGE_HEIGHT) {
      break;
    }
  }
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/** "A", "B", … "Z", "AA" for a 0-based column index. */
export const columnName = (index: number): string => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
};

const NUMERIC = /^[-+]?[\d,.]+%?$/;

/** The top-left corner of a sheet as a spreadsheet grid, with column letters and row numbers. */
export function drawGrid(sheet: Sheet): string | null {
  const surface = createCanvas(SHEET_HEIGHT);
  if (!surface) {
    return null;
  }
  const { canvas, context } = surface;
  context.font = CELL_FONT;

  const columnCount = sheet.rows[0]?.length ?? 0;
  const widths = Array.from({ length: columnCount }, (_, column) => {
    let widest = 0;
    for (const row of sheet.rows) {
      widest = Math.max(widest, context.measureText(row[column]).width);
    }
    return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, widest + CELL_PADDING * 2));
  });

  context.fillStyle = BAND;
  context.fillRect(0, 0, PREVIEW_WIDTH, ROW_HEIGHT);
  context.fillRect(0, 0, HEADER_WIDTH, SHEET_HEIGHT);

  context.strokeStyle = RULE;
  context.lineWidth = 1;
  context.beginPath();
  for (let y = ROW_HEIGHT; y < SHEET_HEIGHT; y += ROW_HEIGHT) {
    context.moveTo(0, y + 0.5);
    context.lineTo(PREVIEW_WIDTH, y + 0.5);
  }
  let x = HEADER_WIDTH;
  const starts = widths.map((columnWidth) => {
    const start = x;
    x += columnWidth;
    return start;
  });
  for (const start of [...starts, x]) {
    context.moveTo(start + 0.5, 0);
    context.lineTo(start + 0.5, SHEET_HEIGHT);
  }
  context.stroke();

  const textTop = (row: number) => row * ROW_HEIGHT + (ROW_HEIGHT - 13) / 2;

  context.fillStyle = MUTED;
  context.textAlign = 'center';
  starts.forEach((start, column) => {
    context.fillText(
      columnName(sheet.firstColumn + column),
      start + widths[column] / 2,
      textTop(0),
    );
  });
  for (let row = 1; row * ROW_HEIGHT < SHEET_HEIGHT; row++) {
    context.fillText(String(sheet.firstRow + row - 1), HEADER_WIDTH / 2, textTop(row));
  }

  context.fillStyle = INK;
  sheet.rows.forEach((cells, index) => {
    const top = (index + 1) * ROW_HEIGHT;
    if (top >= SHEET_HEIGHT) {
      return;
    }
    cells.forEach((text, column) => {
      if (!text || starts[column] >= PREVIEW_WIDTH) {
        return;
      }
      const numeric = NUMERIC.test(text);
      context.save();
      context.beginPath();
      context.rect(starts[column], top, widths[column], ROW_HEIGHT);
      context.clip();
      context.textAlign = numeric ? 'right' : 'left';
      const textX = numeric
        ? starts[column] + widths[column] - CELL_PADDING
        : starts[column] + CELL_PADDING;
      context.fillText(text, textX, textTop(index + 1));
      context.restore();
    });
  });
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/** A picture, such as the scan a Word document is made of, scaled to the preview width. */
export async function drawPicture({ bytes, type }: Picture): Promise<string | null> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  try {
    const height = Math.round((bitmap.height / bitmap.width) * PREVIEW_WIDTH);
    const surface = createCanvas(Math.min(height, PREVIEW_WIDTH * 2));
    if (!surface) {
      return null;
    }
    surface.context.drawImage(bitmap, 0, 0, PREVIEW_WIDTH, height);
    return surface.canvas.toDataURL('image/jpeg', QUALITY);
  } finally {
    bitmap.close();
  }
}
