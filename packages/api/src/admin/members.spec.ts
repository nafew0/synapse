import * as XLSX from 'xlsx';
import { buildMemberWorkbook } from './members';

import type { ExportableMember } from './members';

const DHAKA = 'Asia/Dhaka';

/** `cellNF` populates `z` (the stored number format) and `w` (the text a
 *  spreadsheet actually displays); without it neither is surfaced on read. */
function read(buffer: Buffer): XLSX.WorkSheet {
  return XLSX.read(buffer, { type: 'buffer', cellNF: true }).Sheets['Members'];
}

function build(
  members: ExportableMember[],
  options: {
    timeZone?: string;
    timeZones?: Record<string, string>;
    includeInstitution?: boolean;
  } = {},
): XLSX.WorkSheet {
  return read(
    buildMemberWorkbook(members, {
      timeZone: options.timeZone ?? DHAKA,
      timeZones: options.timeZones,
      includeInstitution: options.includeInstitution ?? false,
    }),
  );
}

const member = (overrides: Partial<ExportableMember> = {}): ExportableMember => ({
  kind: 'user',
  name: 'Ada Rahman',
  email: 'ada@example.bd',
  role: 'USER',
  status: 'active',
  createdAt: '2026-03-10T06:00:00.000Z',
  ...overrides,
});

describe('buildMemberWorkbook', () => {
  it('writes the header row the members table shows', () => {
    const sheet = build([]);
    expect(['A1', 'B1', 'C1', 'D1', 'E1'].map((ref) => sheet[ref]?.v)).toEqual([
      'Name',
      'Email',
      'Role',
      'Status',
      'Added / Sent',
    ]);
    /** No Institution column unless the export spans institutions. */
    expect(sheet['F1']).toBeUndefined();
  });

  it('appends an Institution column only for platform-wide exports', () => {
    const sheet = build([member({ institutionName: 'BdREN' })], { includeInstitution: true });
    expect(sheet['F1'].v).toBe('Institution');
    expect(sheet['F2'].v).toBe('BdREN');
  });

  it('falls back to the tenant id when an institution has no name', () => {
    const sheet = build([member({ tenantId: 'tenant-a' })], { includeInstitution: true });
    expect(sheet['F2'].v).toBe('tenant-a');
  });

  describe('untrusted text', () => {
    it('writes a formula-looking name as a string cell, never a formula', () => {
      const sheet = build([member({ name: '=HYPERLINK("http://evil","clickme")' })]);
      expect(sheet['A2'].t).toBe('s');
      expect(sheet['A2'].f).toBeUndefined();
      expect(sheet['A2'].v).toBe('=HYPERLINK("http://evil","clickme")');
    });

    it.each(['+1', '-1', '@SUM(A1)', '\tlead'])('writes %p verbatim', (name) => {
      const sheet = build([member({ name })]);
      expect(sheet['A2'].f).toBeUndefined();
      expect(sheet['A2'].v).toBe(name);
    });

    it('round-trips commas, quotes and newlines unchanged', () => {
      const name = 'Rahman, "Ada"\nSecond line';
      const sheet = build([member({ name })]);
      expect(sheet['A2'].v).toBe(name);
    });

    /** Name is still free user text, so type inference would coerce a
     *  numeric-looking one and drop a leading zero. */
    it('keeps a numeric-looking name as text', () => {
      const sheet = build([member({ name: '0421' })]);
      expect(sheet['A2'].t).toBe('s');
      expect(sheet['A2'].v).toBe('0421');
    });

    it('round-trips non-ASCII names unchanged', () => {
      const sheet = build([member({ name: 'জোবায়ের Zoë 田中' })]);
      expect(sheet['A2'].v).toBe('জোবায়ের Zoë 田中');
    });
  });

  describe('Added / Sent', () => {
    const formatted = (sheet: XLSX.WorkSheet, ref: string): string => String(sheet[ref].w);

    it('is a real date cell so the column sorts chronologically', () => {
      const sheet = build([member()]);
      expect(sheet['E2'].t).toBe('n');
      expect(sheet['E2'].z).toBe('yyyy-mm-dd');
    });

    /** Guards the whole point of the date cell: a reader must display a date,
     *  not the underlying serial number. */
    it('displays as a formatted date rather than a serial number', () => {
      const sheet = build([member()]);
      expect(sheet['E2'].w).toBe('2026-03-10');
    });

    it('reads back as a real Date for consumers that request them', () => {
      const buffer = buildMemberWorkbook([member()], {
        timeZone: DHAKA,
        includeInstitution: false,
      });
      const cell = XLSX.read(buffer, { type: 'buffer', cellDates: true }).Sheets['Members']['E2'];
      expect(cell.t).toBe('d');
      expect((cell.v as Date).toISOString().slice(0, 10)).toBe('2026-03-10');
    });

    /** 23:45 UTC on the 10th is 05:45 on the 11th in Dhaka (UTC+6). Reporting the
     *  10th would show the admin a different day than the members table did. */
    it('resolves the date in the institution timezone, not UTC', () => {
      const sheet = build([member({ createdAt: '2026-03-10T23:45:00.000Z' })]);
      expect(formatted(sheet, 'E2')).toBe('2026-03-11');
    });

    it('is stable across server timezones for the same institution', () => {
      const sheet = build([member({ createdAt: '2026-03-10T23:45:00.000Z' })], {
        timeZone: 'Pacific/Honolulu',
      });
      expect(formatted(sheet, 'E2')).toBe('2026-03-10');
    });

    it('prefers lastSentAt over createdAt, matching the table', () => {
      const sheet = build([
        member({
          kind: 'invite',
          status: 'invited',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSentAt: '2026-03-12T20:30:00.000Z',
        }),
      ]);
      expect(formatted(sheet, 'E2')).toBe('2026-03-13');
    });

    it('leaves the cell empty when neither date is present', () => {
      const sheet = build([member({ createdAt: null, lastSentAt: null })]);
      expect(sheet['E2'].v).toBe('');
    });

    /**
     * A platform-wide export spans institutions in different zones. One timezone
     * for the whole file would misreport every institution but one.
     */
    it('reports each row in its own institution timezone', () => {
      const sheet = build(
        [
          member({ tenantId: 'dhaka-uni', createdAt: '2026-03-10T23:45:00.000Z' }),
          member({ tenantId: 'hawaii-uni', createdAt: '2026-03-10T23:45:00.000Z' }),
        ],
        { timeZones: { 'dhaka-uni': DHAKA, 'hawaii-uni': 'Pacific/Honolulu' } },
      );

      expect(formatted(sheet, 'E2')).toBe('2026-03-11');
      expect(formatted(sheet, 'E3')).toBe('2026-03-10');
    });

    /** Standalone accounts belong to no institution, so there is no local zone.
     *  Built directly rather than through the helper, whose default would supply
     *  one and hide the fallback. */
    it('falls back to UTC for a member with no institution', () => {
      const sheet = read(
        buildMemberWorkbook(
          [member({ tenantId: undefined, createdAt: '2026-03-10T23:45:00.000Z' })],
          { timeZones: {}, includeInstitution: true },
        ),
      );
      expect(formatted(sheet, 'E2')).toBe('2026-03-10');
    });

    it('leaves the cell empty when a date is unparseable', () => {
      const sheet = build([member({ createdAt: 'not-a-date' })]);
      expect(sheet['E2'].v).toBe('');
    });
  });

  describe('status and role', () => {
    it('reports invite rows with their own status rather than a separate column', () => {
      const sheet = build([
        member({ kind: 'invite', status: 'invited' }),
        member({ kind: 'invite', status: 'expired' }),
      ]);
      expect(sheet['D2'].v).toBe('invited');
      expect(sheet['D3'].v).toBe('expired');
    });

    it.each([
      ['INSTITUTION_ADMIN', 'Institution admin'],
      ['STANDALONE_USER', 'Standalone user'],
      ['USER', 'Institution member'],
      ['INSTITUTION_MEMBER', 'Institution member'],
    ])('labels %s as %s, matching the table', (role, label) => {
      const sheet = build([member({ role })]);
      expect(sheet['C2'].v).toBe(label);
    });
  });

  it('sizes the sheet range to the rows written', () => {
    const sheet = build([member(), member(), member()]);
    expect(sheet['!ref']).toBe('A1:E4');
  });

  it('produces a header-only sheet when nothing matches the filters', () => {
    const sheet = build([]);
    expect(sheet['!ref']).toBe('A1:E1');
    expect(sheet['A2']).toBeUndefined();
  });
});
