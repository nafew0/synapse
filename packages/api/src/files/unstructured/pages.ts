import { PDFDocument } from 'pdf-lib';

/** A PDF of just these 1-based pages, in this order, with their original scan quality. */
export async function subsetPdf(buffer: Uint8Array, pages: number[]): Promise<Buffer> {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const subset = await PDFDocument.create();
  const copied = await subset.copyPages(
    source,
    pages.map((page) => page - 1),
  );
  copied.forEach((page) => subset.addPage(page));
  return Buffer.from(await subset.save());
}
