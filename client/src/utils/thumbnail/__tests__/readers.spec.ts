import { zipSync, strToU8 } from 'fflate';

/** fflate's encoder hands back a Uint8Array from Node's realm, which jsdom's zipSync takes for a folder. */
const bytesOf = (text: string) => new Uint8Array(strToU8(text));
import { readLeadPicture, readParagraphs } from '../word';
import { readSheet } from '../sheet';
import { columnName } from '../draw';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

const archive = (entries: Record<string, string>): ArrayBuffer => {
  const bytes = zipSync(
    Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, bytesOf(text)])),
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const word = (body: string) =>
  archive({
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body>${body}</w:body></w:document>`,
  });

describe('readParagraphs', () => {
  test('keeps the size, weight and alignment a preview can show', () => {
    const paragraphs = readParagraphs(
      word(`
        <w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Annual report</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">Memo </w:t></w:r><w:r><w:tab/><w:t>No. 7</w:t></w:r></w:p>
        <w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Dhaka &amp; Khulna</w:t></w:r></w:p>
      `),
    );

    expect(paragraphs).toEqual([
      { text: 'Annual report', size: 26, bold: true, align: 'center' },
      { text: 'Memo No. 7', size: 14, bold: true, align: 'left' },
      { text: 'Dhaka & Khulna', size: 11, bold: false, align: 'right' },
    ]);
  });

  test('collapses runs of blank paragraphs and drops leading ones', () => {
    const paragraphs = readParagraphs(
      word(
        '<w:p/><w:p/><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p/><w:p/><w:p/><w:p><w:r><w:t>Two</w:t></w:r></w:p>',
      ),
    );

    expect(paragraphs.map((p) => p.text)).toEqual(['One', '', 'Two']);
  });

  test('reads text in a shape once, not again from the copy kept for old readers', () => {
    const paragraphs = readParagraphs(
      word(`<w:p><w:r><mc:AlternateContent>
        <mc:Choice><w:drawing><w:txbxContent><w:p><w:r><w:t>Seal</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice>
        <mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Seal</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback>
      </mc:AlternateContent></w:r></w:p>`),
    );

    expect(paragraphs.map((p) => p.text).filter(Boolean)).toEqual(['Seal']);
  });

  test('gives nothing for a document without text, or without a body at all', () => {
    expect(readParagraphs(word('<w:p/>'))).toEqual([]);
    expect(readParagraphs(archive({ 'docProps/app.xml': '<Properties/>' }))).toEqual([]);
  });
});

describe('readLeadPicture', () => {
  const scan = (target: string) =>
    archive({
      'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p></w:body></w:document>`,
      'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Target="${target}"/></Relationships>`,
      'word/media/image1.png': 'PNG',
      'word/media/image2.emf': 'EMF',
    });

  test('finds the picture a scanned document is made of', () => {
    const picture = readLeadPicture(scan('media/image1.png'));

    expect(picture?.type).toBe('image/png');
    expect(Array.from(picture?.bytes ?? [])).toEqual(Array.from(bytesOf('PNG')));
  });

  test('skips pictures browsers cannot draw, and documents without one', () => {
    expect(readLeadPicture(scan('media/image2.emf'))).toBeNull();
    expect(readLeadPicture(word('<w:p/>'))).toBeNull();
  });
});

const workbook = (sheet: string, extra: Record<string, string> = {}) =>
  archive({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Old" state="hidden" r:id="rId2"/><sheet name="Main" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>',
    ...extra,
  });

describe('readSheet', () => {
  test('reads the first visible sheet from its first filled cell, resolving shared strings', () => {
    const sheet = readSheet(
      workbook(
        `<row r="3"><c r="B3" t="s"><v>1</v></c><c r="D3" t="s"><v>0</v></c></row>
         <row r="4"><c r="B4"><v>1234.567</v></c><c r="C4" t="b"><v>1</v></c><c r="D4" t="str"><f>A1</f><v>x &lt; y</v></c></row>`,
        {
          'xl/sharedStrings.xml':
            '<sst><si><t>Total</t></si><si><r><t>বাজেট </t></r><r><t>২০২৬</t></r><rPh><t>ignored</t></rPh></si></sst>',
        },
      ),
    );

    expect(sheet).toEqual({
      firstRow: 3,
      firstColumn: 1,
      rows: [
        ['বাজেট ২০২৬', '', 'Total'],
        [(1234.567).toLocaleString(undefined, { maximumFractionDigits: 2 }), 'TRUE', 'x < y'],
      ],
    });
  });

  test('keeps to the first 30 rows and 12 columns', () => {
    const rows = Array.from(
      { length: 40 },
      (_, r) =>
        `<row r="${r + 1}">${Array.from({ length: 20 }, (_, c) => `<c t="inlineStr"><is><t>${r}.${c}</t></is></c>`).join('')}</row>`,
    ).join('');

    const sheet = readSheet(workbook(rows));

    expect(sheet?.rows).toHaveLength(30);
    expect(sheet?.rows[0]).toHaveLength(12);
    expect(sheet?.rows[29][11]).toBe('29.11');
  });

  test('gives nothing for an empty sheet or a damaged workbook', () => {
    expect(readSheet(workbook('<row r="1"/>'))).toBeNull();
    expect(readSheet(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).toBeNull();
  });
});

test.each([
  [0, 'A'],
  [25, 'Z'],
  [26, 'AA'],
  [701, 'ZZ'],
  [702, 'AAA'],
])('column %i is named %s', (index, name) => {
  expect(columnName(index)).toBe(name);
});
