import os from 'os';
import path from 'path';
import * as fs from 'fs';
import sharp from 'sharp';
import { classifyPage, isGarbled, measureOperators, summarizeScan } from './classify';
import { EmptyDocumentError, parseDocument } from '../documents/crud';

/**
 * pdf.js is ESM-only and cannot load inside Jest, so real pdf.js runs in a child process and this
 * replays what it returned. The parser under test still sees pdf.js's own text and operators.
 */
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const { execFileSync } = jest.requireActual('child_process');
  const script = `
    import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const pdf = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)), verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { fnArray, argsArray } = await page.getOperatorList();
      const { items } = await page.getTextContent();
      pages.push({ items, fnArray, argsArray: argsArray.map((a) => (Array.isArray(a) && a.length <= 6 ? a : null)), view: page.view });
    }
    process.stdout.write(JSON.stringify({ OPS, pages }), () => process.exit(0));
  `;
  const run = (data: Uint8Array) =>
    JSON.parse(
      execFileSync('node', ['--input-type=module', '-e', script], {
        input: Buffer.from(data),
        maxBuffer: 1024 * 1024 * 64,
      }).toString(),
    );
  const { OPS } = run(jest.requireActual('fs').readFileSync(`${__dirname}/empty.fixture.pdf`));
  return {
    OPS,
    getDocument: ({ data }: { data: Uint8Array }) => {
      const { pages } = run(data);
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (n: number) => {
            const { items, fnArray, argsArray, view } = pages[n - 1];
            return {
              view,
              cleanup: () => undefined,
              getTextContent: async () => ({ items }),
              getOperatorList: async () => ({ fnArray, argsArray }),
            };
          },
        }),
      };
    },
  };
});

const MIN_CHARS = 100;
const PROSE = 'The committee approved the revised budget for the coming financial year. '.repeat(4);
const PAGE = [595, 842] as const;

/** Escapes bytes for a PDF literal string, so WinAnsi punctuation survives. */
const literal = (text: string): string =>
  text.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, (ch) => {
    const code = { '‡': 0o207, '¨': 0o250, '¦': 0o246 }[ch] ?? 0x3f;
    return `\\${code.toString(8).padStart(3, '0')}`;
  });

interface PageSpec {
  text?: string;
  /** Text render mode 3: painted by nobody, as a scanner's OCR layer is. */
  invisible?: boolean;
  /** A JPEG scaled to this share of the page's width and height. */
  image?: Buffer;
  imageScale?: number;
}

/** A small real PDF, so the tests run pdf.js itself rather than a stand-in for it. */
function buildPdf(pages: PageSpec[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const kids = pages.map(({ text, invisible, image, imageScale = 1 }) => {
    let content = '';
    let xobject = '';
    if (text) {
      const lines = (text.match(/[^]{1,90}/g) ?? [])
        .map((line) => `(${literal(line)}) '`)
        .join(' ');
      content += `BT /F1 9 Tf 11 TL ${invisible ? '3 Tr ' : ''}40 790 Td ${lines} ET\n`;
    }
    if (image) {
      const width = PAGE[0] * imageScale;
      const height = PAGE[1] * imageScale;
      const head = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`;
      const id = add(Buffer.concat([Buffer.from(head), image, Buffer.from('\nendstream')]));
      xobject = `/XObject << /Im0 ${id} 0 R >>`;
      content += `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    return add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE[0]} ${PAGE[1]}] /Resources << /Font << /F1 3 0 R >> ${xobject} >> /Contents ${stream} 0 R >>`,
    );
  });
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let offset = parts[0].length;
  objects.forEach((object, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    offsets.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

describe('scan classifier', () => {
  let dir: string;
  let jpeg: Buffer;

  const parsePdf = async (pages: PageSpec[]) => {
    const filePath = path.join(dir, `${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(filePath, buildPdf(pages));
    const file = { originalname: 'doc.pdf', path: filePath, mimetype: 'application/pdf' };
    return parseDocument({ file: file as Express.Multer.File });
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-classify-'));
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ddd' } })
      .jpeg()
      .toBuffer();
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('real PDFs through pdf.js', () => {
    it('leaves a digital page alone', async () => {
      const { scan } = await parsePdf([{ text: PROSE }]);
      expect(scan).toEqual({ pages: 1, ocrPages: [], garbledPages: [] });
    });

    it('keeps the verdicts when a fully scanned PDF has no text to return', async () => {
      const error = await parsePdf([{ image: jpeg }, { image: jpeg }]).catch((err) => err);
      expect(error).toBeInstanceOf(EmptyDocumentError);
      expect(error.message).toBe('No text found in document');
      expect(error.scan).toEqual({ pages: 2, ocrPages: [1, 2], garbledPages: [] });
    });

    it('finds the scanned annexe in a mixed PDF, which an average would miss', async () => {
      const { scan } = await parsePdf([{ text: PROSE }, { text: PROSE }, { image: jpeg }]);
      expect(scan?.ocrPages).toEqual([3]);
    });

    it("treats a scanner's invisible OCR layer as a scan", async () => {
      const { scan } = await parsePdf([{ text: PROSE, invisible: true, image: jpeg }]);
      expect(scan?.ocrPages).toEqual([1]);
    });

    it('treats text painted under a full-page image as a scan', async () => {
      const { scan } = await parsePdf([{ text: PROSE, image: jpeg }]);
      expect(scan?.ocrPages).toEqual([1]);
    });

    it('does not pay to read a short cover page or a small logo', async () => {
      const { scan } = await parsePdf([
        { text: 'National AI Policy 2026' },
        { text: PROSE, image: jpeg, imageScale: 0.2 },
        { text: PROSE },
      ]);
      expect(scan?.ocrPages).toEqual([]);
    });

    it('flags Bangla whose conjuncts pdf.js returned as control characters', () => {
      /* Recorded from a real LibreOffice export; Chrome's PDFs read the same way. */
      expect(
        isGarbled(
          'বাং\u0002\u0003লা\u0002দে\u0006শ বিবাংশ্ব বিবাংদ্যা \u0002 লায় মঞ্জু রী\u0010 কবিমশন',
        ),
      ).toBe(true);
    });

    it('flags a Bijoy page, whose Bangla reads as Latin punctuation', async () => {
      const bijoy = 'evsjv‡`k wek¦we`¨vjq gÄyix Kwgkb '.repeat(5);
      const { scan } = await parsePdf([{ text: bijoy }, { text: PROSE }]);
      expect(scan).toEqual({ pages: 2, ocrPages: [1], garbledPages: [1] });
    });
  });

  describe('isGarbled', () => {
    const bangla = 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন শিক্ষা মন্ত্রণালয় '.repeat(4);

    it.each([
      ['clean Bangla', bangla],
      ['clean English', PROSE],
      ['a copyright line', `${PROSE} © 2026 — BdREN® ¶`],
      ['two typos in Bangla', `${bangla} িক েক`],
    ])('accepts %s', (_name, text) => {
      expect(isGarbled(text)).toBe(false);
    });

    it.each([
      ['conjuncts as control characters', 'বাংলা\u0001দেশ '.repeat(20)],
      ['private-use glyphs', `${'\ue001\ue002abc '.repeat(10)}`],
      ['drawn order', 'িব েদশ ৈক িম েন ি ক'],
    ])('rejects %s', (_name, text) => {
      expect(isGarbled(text)).toBe(true);
    });
  });

  describe('classifyPage', () => {
    const page = { text: '', imageCoverage: 0, hiddenText: false, pathCount: 0, glyphCount: 0 };

    it('treats a page of outlined text as a scan', () => {
      expect(classifyPage({ ...page, pathCount: 500 }, MIN_CHARS)).toBe('scan');
    });

    it('leaves a blank page out', () => {
      expect(classifyPage(page, MIN_CHARS)).toBe('text');
    });

    it('treats a mostly-image page with a caption as a scan, but not a designed page', () => {
      const caption = { ...page, text: 'x'.repeat(200), imageCoverage: 0.7 };
      expect(classifyPage(caption, MIN_CHARS)).toBe('scan');
      const designed = { ...page, text: 'x'.repeat(2000), imageCoverage: 1 };
      expect(classifyPage(designed, MIN_CHARS)).toBe('text');
    });
  });

  describe('a page that draws text it never gives', () => {
    /* A UGC notice: Bijoy header fragments read, the body's 900-odd glyphs mapped to nothing. */
    const notice = {
      text: 'evsjv‡`k wek¦we`¨vjq gÄyix Kwgkb '.repeat(6),
      imageCoverage: 0.015,
      hiddenText: false,
      pathCount: 104,
      glyphCount: 1146,
    };

    it('needs reading as a scan, not repairing as garbled text', () => {
      expect(isGarbled(notice.text)).toBe(true);
      expect(classifyPage(notice, MIN_CHARS)).toBe('scan');
    });

    it('leaves a readable page alone, though spaces and conjuncts are glyphs too', () => {
      const bangla = { ...notice, text: 'ক'.repeat(620), glyphCount: 1000 };
      expect(classifyPage(bangla, MIN_CHARS)).toBe('text');
      const cover = { ...notice, text: 'x'.repeat(10), glyphCount: 99 };
      expect(classifyPage(cover, MIN_CHARS)).toBe('text');
    });

    it('counts drawn glyphs, not the spacing numbers between them', () => {
      const ops = {
        save: 1,
        restore: 2,
        transform: 3,
        paintFormXObjectBegin: 4,
        paintFormXObjectEnd: 5,
        paintImageXObject: 6,
        paintInlineImageXObject: 7,
        paintImageMaskXObject: 8,
        setTextRenderingMode: 9,
        showText: 10,
        showSpacedText: 11,
        constructPath: 12,
      };
      const glyph = { unicode: '', fontChar: 'a' };
      const measured = measureOperators({
        fnArray: [ops.showText, ops.showSpacedText],
        argsArray: [[[glyph, glyph, glyph]], [[glyph, -120, glyph, null]]],
        ops,
        pageArea: PAGE[0] * PAGE[1],
      });
      expect(measured.glyphCount).toBe(5);
    });
  });

  it('summarizes with 1-based page numbers', () => {
    expect(summarizeScan(['text', 'scan', 'garbled'])).toEqual({
      pages: 3,
      ocrPages: [2, 3],
      garbledPages: [3],
    });
  });
});
