import type { DoclingDocument } from './types';
import { KB_TABLE_BUDGET, KB_TEXT_BUDGET, chunkElements } from './chunk';
import contacts from './__fixtures__/contacts.docling.json';
import usage from './__fixtures__/usage.docling.json';
import { cleanText } from './normalize';
import { toElements } from './elements';

const contactsDoc = contacts as unknown as DoclingDocument;
const usageDoc = usage as unknown as DoclingDocument;

describe('cleanText', () => {
  it('rejoins a Bangla vowel sign the text layer split from its consonant', () => {
    expect(cleanText('টিকিট খ ু লবে')).toBe('টিকিট খুলবে');
  });

  it('drops dotted circles and collapses spaces but keeps paragraph breaks', () => {
    expect(cleanText('ক◌ি   খ\n\n\n\nগ')).toBe('কি খ\n\nগ');
  });
});

describe('toElements', () => {
  it('reads a digital PDF into headings, text and tables with their headers', () => {
    const { elements, pageCount } = toElements(contactsDoc);
    expect(pageCount).toBe(1);
    const tables = elements.filter((element) => element.kind === 'table');
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({
      header: ['Team', 'দল', 'Email', 'Phone', 'Hours'],
      pageStart: 1,
    });
    expect(tables[0].kind === 'table' && tables[0].rows[0]).toEqual([
      'Network Operations Centre (NOC)',
      'নেটওয়ার্ক অপারেশন সেন্টার',
      'noc@bdren.net.bd',
      '+880 1711 000111',
      '24/7',
    ]);
    expect(elements.some((e) => e.kind === 'text' && e.text.includes('খুলবে'))).toBe(true);
  });

  it('turns a sheet into a heading and blanks the cells a merged cell covers', () => {
    const { elements } = toElements(usageDoc);
    expect(elements[0]).toMatchObject({ kind: 'heading', text: 'Member usage', level: 1 });
    const summary = elements.find((e) => e.kind === 'table');
    expect(summary?.kind === 'table' && summary.rows[0]).toEqual([
      'Institution',
      'Run Test University',
      '',
      '',
    ]);
  });

  it('reads one-row layout tables, such as a letterhead, as plain text', () => {
    const cell = (text: string, col: number) => ({
      text,
      column_header: true,
      start_row_offset_idx: 0,
      start_col_offset_idx: col,
    });
    const doc = {
      ...contactsDoc,
      body: { self_ref: '#/body', label: 'unspecified', children: [{ $ref: '#/tables/0' }] },
      groups: [],
      texts: [],
      pictures: [],
      tables: [
        {
          self_ref: '#/tables/0',
          label: 'table',
          children: [],
          prov: [],
          data: {
            num_rows: 1,
            num_cols: 2,
            grid: [[cell('স্মারক নং- ৩৩২', 0), cell('তারিখ : ১৬ সেপ্টেম্বর ২০২৬', 1)]],
          },
        },
      ],
    } as unknown as DoclingDocument;
    expect(toElements(doc).elements).toEqual([
      { kind: 'text', text: 'স্মারক নং- ৩৩২', page: null },
      { kind: 'text', text: 'তারিখ : ১৬ সেপ্টেম্বর ২০২৬', page: null },
    ]);
  });
});

describe('chunkElements', () => {
  it('keeps each section apart and puts title and section in the embedded text', () => {
    const chunks = chunkElements('BdREN contacts', toElements(contactsDoc).elements);
    const directory = chunks.find((chunk) => chunk.text.includes('noc@bdren.net.bd'));
    expect(directory).toMatchObject({
      kind: 'table',
      sectionPath: '1. Team directory',
      pageStart: 1,
    });
    expect(directory?.text.startsWith('| Team | দল | Email | Phone | Hours |\n| --- |')).toBe(true);
    expect(directory?.embedText).toMatch(/^BdREN contacts › 1\. Team directory\n\n\| Team/);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });

  it('splits a long table into row groups that each repeat the header', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`Office ${i}`, `office${i}@example.edu`]);
    const chunks = chunkElements('Directory', [
      { kind: 'table', header: ['Office', 'Email'], rows, pageStart: 2, pageEnd: 4 },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('| Office | Email |\n| --- | --- |\n')).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(KB_TABLE_BUDGET + 60);
    }
    const all = chunks.map((chunk) => chunk.text).join('\n');
    expect(all).toContain('office0@example.edu');
    expect(all).toContain('office199@example.edu');
  });

  it('splits an over-long paragraph at sentence ends', () => {
    const sentence = 'প্রতিটি সদস্য প্রতিষ্ঠান নিয়মিত প্রতিবেদন জমা দেবে।';
    const text = Array.from({ length: 120 }, () => sentence).join(' ');
    const chunks = chunkElements('Policy', [{ kind: 'text', text, page: 3 }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(KB_TEXT_BUDGET);
      expect(chunk.text.endsWith('।')).toBe(true);
    }
  });

  it('nests sections by heading level and pops back up', () => {
    const chunks = chunkElements('Handbook', [
      { kind: 'heading', text: 'Leave', level: 1, page: 1 },
      { kind: 'heading', text: 'Casual leave', level: 2, page: 1 },
      { kind: 'text', text: 'Twenty days a year.', page: 1 },
      { kind: 'heading', text: 'Travel', level: 1, page: 2 },
      { kind: 'text', text: 'Book through the admin office.', page: 2 },
    ]);
    expect(chunks.map((chunk) => chunk.sectionPath)).toEqual(['Leave › Casual leave', 'Travel']);
  });
});
