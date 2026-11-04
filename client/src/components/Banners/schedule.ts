import type { TBanner } from 'librechat-data-provider';
import type { CategoryStyle } from './styles';

const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `Intl` throws on a malformed tag; fall back to the browser's own locale. */
function format(date: Date, lang: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return date.toLocaleString(lang, options);
  } catch {
    return date.toLocaleString(undefined, options);
  }
}

/** Time alone for today, date and time otherwise. */
function formatMoment(date: Date, lang: string, now: Date): string {
  const options = date.toDateString() === now.toDateString() ? TIME : { ...DAY, ...TIME };
  return format(date, lang, options);
}

export interface BannerSchedule {
  /** "Until …" / "Since …" for maintenance and outages. */
  window?: { kind: 'until' | 'since'; moment: string };
  /** Start date shown in the card header for news. */
  day?: string;
}

export function getSchedule(
  banner: TBanner,
  style: CategoryStyle,
  lang: string,
  now: Date = new Date(),
): BannerSchedule {
  if (!style.window) {
    const start = toDate(banner.displayFrom);
    return start ? { day: format(start, lang, DAY) } : {};
  }
  const date = toDate(style.window === 'until' ? banner.displayTo : banner.displayFrom);
  return date ? { window: { kind: style.window, moment: formatMoment(date, lang, now) } } : {};
}
