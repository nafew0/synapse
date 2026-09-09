import * as XLSX from 'xlsx';
import { logger } from '@librechat/data-schemas';

import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

/** `resolveAdminTenant` resolves which institution an admin request applies to. */
type AdminRequest = ServerRequest & {
  adminTenantId?: string;
  isPlatformSuperadmin?: boolean;
};

/** One roster row as the members list reports it. */
export interface ExportableMember {
  kind: 'user' | 'invite';
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  institutionName?: string;
  tenantId?: string;
  createdAt?: string | null;
  lastSentAt?: string | null;
}

export interface MemberExportFilters {
  tenantId?: string;
  accountScope?: 'institution' | 'standalone';
  query?: string;
  status?: string;
  role?: string;
}

/** Maps a tenant to the timezone its dates are reported in. */
export type InstitutionTimezones = Record<string, string>;

type MemberStream = (
  filters: MemberExportFilters,
  onMember: (member: ExportableMember) => void | Promise<void>,
  options: { isCancelled: () => boolean },
) => Promise<{ count: number }>;

export interface AdminMembersDeps {
  /** Scoped to one institution; the only path an institution admin can reach. */
  streamInstitutionMembers: MemberStream;
  /** Every institution, one institution, or the standalone accounts. */
  streamPlatformMembers: MemberStream;
  getInstitutionTimezones: (tenantId?: string) => Promise<InstitutionTimezones>;
  recordMemberExportAudit: (input: {
    tenantId?: string;
    actor: AdminRequest['user'];
    filters: Omit<MemberExportFilters, 'tenantId'>;
    rowCount: number;
  }) => Promise<void>;
}

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel's epoch is 1899-12-30; 25569 is the offset from the Unix epoch in days. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;
const DATE_NUMBER_FORMAT = 'yyyy-mm-dd';

/** Standalone accounts belong to no institution, so they have no local zone. */
const FALLBACK_TIMEZONE = 'UTC';

/** Matches the labels the members table renders (`UsersPage.tsx` `roleLabel`). */
function roleLabel(role?: string): string {
  switch (role) {
    case 'INSTITUTION_ADMIN':
      return 'Institution admin';
    case 'STANDALONE_USER':
      return 'Standalone user';
    default:
      return 'Institution member';
  }
}

/**
 * The calendar date as the institution sees it, not as the server's clock does.
 * A member added at 23:30 local time must not export with the following day.
 */
function toInstitutionDateParts(
  value: Date,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);

  const lookup = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number.parseInt(found.value, 10) : Number.NaN;
  };

  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return null;
  }
  return { year, month, day };
}

/**
 * A real date cell rather than text, so the column sorts chronologically and
 * renders in the reader's own locale. The serial is computed from the
 * institution-local Y/M/D so no timezone conversion happens downstream.
 */
function toExcelDateSerial(value: Date, timeZone: string): number | null {
  const parts = toInstitutionDateParts(value, timeZone);
  if (!parts) {
    return null;
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
}

function parseDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type SheetCell = XLSX.CellObject;

function textCell(value?: string | null): SheetCell {
  /** Always `t: 's'`. Inference would turn a name beginning with `=` into a
   *  formula, and would coerce a numeric-looking value to a number. */
  return { t: 's', v: value == null ? '' : String(value) };
}

function dateCell(value: Date | null, timeZone: string): SheetCell {
  if (!value) {
    return textCell('');
  }
  const serial = toExcelDateSerial(value, timeZone);
  if (serial == null) {
    return textCell('');
  }
  return { t: 'n', v: serial, z: DATE_NUMBER_FORMAT };
}

type TimeZoneFor = (member: ExportableMember) => string;

interface ColumnSpec {
  label: string;
  width: number;
  cell: (member: ExportableMember, timeZone: string) => SheetCell;
}

const BASE_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { label: 'Name', width: 28, cell: (m) => textCell(m.name) },
  { label: 'Email', width: 32, cell: (m) => textCell(m.email) },
  { label: 'Role', width: 20, cell: (m) => textCell(roleLabel(m.role)) },
  { label: 'Status', width: 14, cell: (m) => textCell(m.status) },
  {
    label: 'Added / Sent',
    width: 16,
    /** Same fallback the table uses: an invite reports when it was last sent, a
     *  member when the account was created. */
    cell: (m, tz) => dateCell(parseDate(m.lastSentAt) ?? parseDate(m.createdAt), tz),
  },
];

const INSTITUTION_COLUMN: ColumnSpec = {
  label: 'Institution',
  width: 28,
  cell: (m) => textCell(m.institutionName ?? m.tenantId),
};

export function buildMemberWorkbook(
  members: ReadonlyArray<ExportableMember>,
  {
    timeZone,
    timeZones,
    includeInstitution,
  }: {
    /** Single-institution exports; ignored when `timeZones` is supplied. */
    timeZone?: string;
    /** Platform exports spanning institutions in different zones. */
    timeZones?: InstitutionTimezones;
    includeInstitution: boolean;
  },
): Buffer {
  const columns = includeInstitution ? [...BASE_COLUMNS, INSTITUTION_COLUMN] : BASE_COLUMNS;
  const timeZoneFor: TimeZoneFor = (member) =>
    (member.tenantId ? timeZones?.[member.tenantId] : undefined) ?? timeZone ?? FALLBACK_TIMEZONE;
  const sheet: XLSX.WorkSheet = {};

  for (let c = 0; c < columns.length; c++) {
    sheet[XLSX.utils.encode_cell({ r: 0, c })] = textCell(columns[c].label);
  }

  for (let r = 0; r < members.length; r++) {
    const member = members[r];
    const zone = timeZoneFor(member);
    for (let c = 0; c < columns.length; c++) {
      sheet[XLSX.utils.encode_cell({ r: r + 1, c })] = columns[c].cell(member, zone);
    }
  }

  sheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: members.length, c: columns.length - 1 },
  });
  sheet['!cols'] = columns.map((column) => ({ wch: column.width }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Members');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function readFilter(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed !== 'all' ? trimmed : undefined;
}

function readAccountScope(value: unknown): 'institution' | 'standalone' {
  return value === 'standalone' ? 'standalone' : 'institution';
}

export function createAdminMembersHandlers(deps: AdminMembersDeps): {
  exportMembers: (req: AdminRequest, res: Response) => Promise<Response | void>;
} {
  const {
    streamInstitutionMembers,
    streamPlatformMembers,
    getInstitutionTimezones,
    recordMemberExportAudit,
  } = deps;

  async function exportMembers(req: AdminRequest, res: Response) {
    const tenantId = req.adminTenantId;
    /**
     * A superadmin belongs to no institution, so an unscoped request is theirs and
     * means "everything I can see" rather than a missing parameter. An institution
     * admin always arrives with their own tenant resolved by the middleware.
     */
    const isPlatformScope = req.isPlatformSuperadmin === true;
    if (!tenantId && !isPlatformScope) {
      return res.status(403).json({ error: 'Institution admin access requires a tenant context' });
    }

    /**
     * A workbook cannot be emitted incrementally, so an abandoned download would
     * otherwise keep reading a roster nobody is waiting for. `close` covers a
     * TCP reset as well as a graceful end.
     */
    let clientAborted = false;
    const markAborted = () => {
      clientAborted = true;
    };
    res.once('close', markAborted);

    const filters = {
      query: readFilter(req.query?.q),
      status: readFilter(req.query?.status),
      role: readFilter(req.query?.role),
      ...(isPlatformScope ? { accountScope: readAccountScope(req.query?.accountScope) } : null),
    };

    try {
      const timeZones = await getInstitutionTimezones(tenantId);
      const members: ExportableMember[] = [];
      const stream = isPlatformScope ? streamPlatformMembers : streamInstitutionMembers;
      await stream(
        { ...filters, ...(tenantId ? { tenantId } : null) },
        (member) => {
          members.push(member);
        },
        { isCancelled: () => clientAborted },
      );

      if (clientAborted) {
        return;
      }

      const buffer = buildMemberWorkbook(members, {
        timeZones,
        includeInstitution: isPlatformScope,
      });

      await recordMemberExportAudit({
        tenantId,
        actor: req.user,
        filters,
        rowCount: members.length,
      });

      const filename = `members-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(buffer);
    } catch (error) {
      logger.error('[adminMembers] member export failed', error);
      if (clientAborted || res.headersSent) {
        return;
      }
      return res.status(500).json({ error: 'Failed to export members' });
    } finally {
      res.removeListener('close', markAborted);
    }
  }

  return { exportMembers };
}
