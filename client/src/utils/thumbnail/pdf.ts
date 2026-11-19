import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Draws the first page of a PDF `width` pixels wide and returns it as a JPEG data URL. */
export async function renderPdfPage(data: ArrayBuffer, width: number): Promise<string> {
  const pdf = await getDocument({ data, isEvalSupported: false }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    await pdf.destroy();
  }
}
