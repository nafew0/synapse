import { decodeXml, readTexts } from './zip';

const WORKBOOK = 'xl/workbook.xml';
const RELATIONS = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const MAX_ROWS = 30;
const MAX_COLUMNS = 12;

export type Sheet = {
  /** Cell text, row by row, starting at `firstRow` and `firstColumn`. */
  rows: string[][];
  /** 1-based row number of the first row. */
  firstRow: number;
  /** 0-based column index of the first column (0 is A). */
  firstColumn: number;
};

type RawCell = { row: number; column: number; type: string; value: string };

const attribute = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

/** "AB12" → 27, the 0-based column of a cell reference. */
const columnOf = (reference: string): number => {
  let column = 0;
  for (const letter of reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? '') {
    column = column * 26 + letter.charCodeAt(0) - 64;
  }
  return column - 1;
};

const textRuns = (xml: string): string =>
  decodeXml(
    Array.from(xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([^<]*)<\/t>/g))
      .map((match) => match[1])
      .join(''),
  );

/** The path of the first sheet a reader would see, skipping hidden ones. */
const firstSheetPath = (workbook: string, relations: string): string | null => {
  const sheet = Array.from(workbook.matchAll(/<sheet\b([^>]*)>/g))
    .map((match) => match[1])
    .find((tag) => !/\bstate="(hidden|veryHidden)"/.test(tag));
  const id = sheet?.match(/\b\w+:id="([^"]+)"/)?.[1];
  const relation = Array.from(relations.matchAll(/<Relationship\b([^>]*)>/g))
    .map((match) => match[1])
    .find((tag) => attribute(tag, 'Id') === id);
  const target = relation ? attribute(relation, 'Target') : undefined;
  if (!id || !target) {
    return null;
  }
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
};

/** Cells from the first rows that hold anything, read without parsing the rest of the sheet. */
const readCells = (xml: string): RawCell[] => {
  const cells: RawCell[] = [];
  let rowsWithContent = 0;
  let rowNumber = 0;
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNumber = Number(attribute(row[1], 'r')) || rowNumber + 1;
    let column = -1;
    let found = false;
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = attribute(cell[1], 'r');
      column = reference ? columnOf(reference) : column + 1;
      const type = attribute(cell[1], 't') ?? 'n';
      const body = cell[2] ?? '';
      const value =
        type === 'inlineStr' ? textRuns(body) : decodeXml(body.match(/<v>([^<]*)<\/v>/)?.[1] ?? '');
      if (value !== '') {
        cells.push({ row: rowNumber, column, type, value });
        found = true;
      }
    }
    rowsWithContent += found ? 1 : 0;
    if (rowsWithContent >= MAX_ROWS) {
      break;
    }
  }
  return cells;
};

/** Shared strings up to `last`, the highest index the visible cells use. */
const readSharedStrings = (xml: string | undefined, last: number): string[] => {
  const strings: string[] = [];
  if (!xml || last < 0) {
    return strings;
  }
  for (const item of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    strings.push(textRuns(item[1] ?? ''));
    if (strings.length > last) {
      break;
    }
  }
  return strings;
};

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

const display = (cell: RawCell, shared: string[]): string => {
  if (cell.type === 's') {
    return shared[Number(cell.value)] ?? '';
  }
  if (cell.type === 'b') {
    return cell.value === '1' ? 'TRUE' : 'FALSE';
  }
  if (cell.type === 'n' && NUMBER.test(cell.value)) {
    return Number(cell.value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return cell.value;
};

/**
 * The top-left corner of a workbook's first visible sheet: up to 30 rows and 12 columns, starting
 * at the first row and column that hold anything. Gives null for an empty or unreadable workbook.
 */
export function readSheet(data: ArrayBuffer): Sheet | null {
  const book = readTexts(data, [WORKBOOK, RELATIONS, SHARED_STRINGS]);
  const path = firstSheetPath(book[WORKBOOK] ?? '', book[RELATIONS] ?? '');
  const xml = path ? readTexts(data, [path])[path] : undefined;
  const cells = xml ? readCells(xml) : [];
  if (cells.length === 0) {
    return null;
  }

  let firstRow = Infinity;
  let firstColumn = Infinity;
  let lastShared = -1;
  for (const cell of cells) {
    firstRow = Math.min(firstRow, cell.row);
    firstColumn = Math.min(firstColumn, cell.column);
    if (cell.type === 's') {
      lastShared = Math.max(lastShared, Number(cell.value));
    }
  }
  const shared = readSharedStrings(book[SHARED_STRINGS], lastShared);

  const rows: string[][] = [];
  let width = 0;
  for (const cell of cells) {
    const row = cell.row - firstRow;
    const column = cell.column - firstColumn;
    if (row >= MAX_ROWS || column >= MAX_COLUMNS) {
      continue;
    }
    while (rows.length <= row) {
      rows.push([]);
    }
    rows[row][column] = display(cell, shared);
    width = Math.max(width, column + 1);
  }
  return {
    rows: rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? '')),
    firstRow,
    firstColumn,
  };
}
