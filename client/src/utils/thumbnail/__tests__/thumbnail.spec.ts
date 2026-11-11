import { zipSync, strToU8 } from 'fflate';
import { getThumbnail } from '../index';
import { renderPdfPage } from '../pdf';

/** pdf.js needs a real canvas, which jsdom lacks; its drawing is checked in the browser. */
jest.mock('../pdf', () => ({
  renderPdfPage: jest.fn(async () => 'data:image/jpeg;base64,cGFnZQ=='),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const officeFile = (name: string, entries: Record<string, Uint8Array>) =>
  new File([zipSync(entries) as Uint8Array<ArrayBuffer>], name);

describe('getThumbnail', () => {
  test('reads the preview picture a PowerPoint file carries', async () => {
    const file = officeFile('deck.pptx', {
      '[Content_Types].xml': strToU8('<Types/>'),
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

  test('gives nothing for an Office file saved without a preview picture', async () => {
    const file = officeFile('report.docx', { 'word/document.xml': strToU8('<w:document/>') });

    await expect(getThumbnail(file)).resolves.toBeNull();
  });

  test('gives nothing for a damaged Office file', async () => {
    await expect(getThumbnail(new File(['not a zip'], 'broken.xlsx'))).resolves.toBeNull();
  });

  test('draws the first page of a PDF, once per file', async () => {
    const file = new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' });

    await expect(getThumbnail(file)).resolves.toBe('data:image/jpeg;base64,cGFnZQ==');
    await getThumbnail(file);

    expect(renderPdfPage).toHaveBeenCalledTimes(1);
    expect(renderPdfPage).toHaveBeenCalledWith(expect.any(ArrayBuffer), 112);
  });

  test('gives nothing for file types that have no page to draw', async () => {
    await expect(getThumbnail(new File(['a,b'], 'table.csv'))).resolves.toBeNull();
  });
});
