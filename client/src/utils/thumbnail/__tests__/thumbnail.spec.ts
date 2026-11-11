import { zipSync, strToU8 } from 'fflate';

/** fflate's encoder hands back a Uint8Array from Node's realm, which jsdom's zipSync takes for a folder. */
const bytesOf = (text: string) => new Uint8Array(strToU8(text));
import { getThumbnail } from '../index';
import { drawGrid, drawPage } from '../draw';
import { renderPdfPage } from '../pdf';

/** pdf.js needs a real canvas, which jsdom lacks; its drawing is checked in the browser. */
jest.mock('../pdf', () => ({
  renderPdfPage: jest.fn(async () => 'data:image/jpeg;base64,cGFnZQ=='),
}));

/** Drawing needs a real canvas too; what gets drawn is checked here, the pixels in the browser. */
jest.mock('../draw', () => ({
  ...jest.requireActual('../draw'),
  drawPage: jest.fn(() => 'data:image/jpeg;base64,cGFnZQ=='),
  drawGrid: jest.fn(() => 'data:image/jpeg;base64,Z3JpZA=='),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const officeFile = (name: string, entries: Record<string, Uint8Array>) =>
  new File([zipSync(entries) as Uint8Array<ArrayBuffer>], name);

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

describe('getThumbnail', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reads the preview picture a PowerPoint file carries', async () => {
    const file = officeFile('deck.pptx', {
      '[Content_Types].xml': bytesOf('<Types/>'),
      'docProps/thumbnail.jpeg': PNG_BYTES,
    });

    await expect(getThumbnail(file)).resolves.toBe(
      `data:image/jpeg;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`,
    );
  });

  test('reads the PNG preview an OpenDocument file carries', async () => {
    const file = officeFile('notes.odt', { 'Thumbnails/thumbnail.png': PNG_BYTES });

    await expect(getThumbnail(file)).resolves.toMatch(/^data:image\/png;base64,/);
  });

  test('gives nothing for a PowerPoint file saved without a preview picture', async () => {
    const file = officeFile('deck.pptx', { '[Content_Types].xml': bytesOf('<Types/>') });

    await expect(getThumbnail(file)).resolves.toBeNull();
  });

  test('draws a Word file from its text, ignoring the blank picture Word for Mac saves', async () => {
    const file = officeFile('memo.docx', {
      'docProps/thumbnail.jpeg': PNG_BYTES,
      'word/document.xml': bytesOf(
        `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Office order</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });

    await expect(getThumbnail(file)).resolves.toBe('data:image/jpeg;base64,cGFnZQ==');
    expect(drawPage).toHaveBeenCalledWith([
      { text: 'Office order', size: 11, bold: false, align: 'left' },
    ]);
  });

  test('gives nothing for a Word file with no text', async () => {
    const file = officeFile('empty.docx', {
      'word/document.xml': bytesOf(
        `<w:document xmlns:w="${W}"><w:body><w:p/></w:body></w:document>`,
      ),
    });

    await expect(getThumbnail(file)).resolves.toBeNull();
    expect(drawPage).not.toHaveBeenCalled();
  });

  test('draws an Excel file from the cells of its first sheet', async () => {
    const file = officeFile('budget.xlsx', {
      'xl/workbook.xml': bytesOf(
        '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': bytesOf(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': bytesOf(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c></row></sheetData></worksheet>',
      ),
    });

    await expect(getThumbnail(file)).resolves.toBe('data:image/jpeg;base64,Z3JpZA==');
    expect(drawGrid).toHaveBeenCalledWith({ rows: [['Item']], firstRow: 1, firstColumn: 0 });
  });

  test('gives nothing for a damaged Office file', async () => {
    await expect(getThumbnail(new File(['not a zip'], 'broken.xlsx'))).resolves.toBeNull();
  });

  test('draws the first page of a PDF, once per file', async () => {
    const file = new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' });

    await expect(getThumbnail(file)).resolves.toBe('data:image/jpeg;base64,cGFnZQ==');
    await getThumbnail(file);

    expect(renderPdfPage).toHaveBeenCalledTimes(1);
    expect(renderPdfPage).toHaveBeenCalledWith(expect.any(ArrayBuffer), 480);
  });

  test('gives nothing for file types that have no page to draw', async () => {
    await expect(getThumbnail(new File(['a,b'], 'table.csv'))).resolves.toBeNull();
  });
});
