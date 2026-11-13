import { ocrToElements, parseHtmlTable } from './ocr';

describe('parseHtmlTable', () => {
  it('reads header cells, blanks the columns a spanning cell covers and decodes entities', () => {
    expect(
      parseHtmlTable(
        '<table><thead><tr><th>Team</th><th>Email</th><th>Phone</th></tr></thead>' +
          '<tbody><tr><td colspan="2">NOC &amp; CSIRT</td><td>0171</td></tr>' +
          '<tr><td>Desk</td><td>support@bdren.net.bd</td></tr></tbody></table>',
      ),
    ).toEqual({
      header: ['Team', 'Email', 'Phone'],
      rows: [
        ['NOC & CSIRT', '', '0171'],
        ['Desk', 'support@bdren.net.bd', ''],
      ],
    });
  });

  it('has no header when no row uses header cells', () => {
    expect(parseHtmlTable('<table><tr><td>১।</td><td>সচিব</td></tr></table>')).toEqual({
      header: [],
      rows: [['১।', 'সচিব']],
    });
  });
});

describe('ocrToElements', () => {
  it('puts each element on its original page and skips page furniture', () => {
    const elements = ocrToElements(
      [
        { type: 'Header', text: 'UGC', metadata: { page_number: 1 } },
        { type: 'Title', text: 'অফিস আদেশ', metadata: { page_number: 1 } },
        { type: 'ListItem', text: 'সচিব', metadata: { page_number: 2 } },
        { type: 'PageNumber', text: '2', metadata: { page_number: 2 } },
      ],
      [3, 7],
    );
    expect(elements).toEqual([
      { kind: 'heading', text: 'অফিস আদেশ', level: 1, page: 3 },
      { kind: 'text', text: '• সচিব', page: 7 },
    ]);
  });
});
