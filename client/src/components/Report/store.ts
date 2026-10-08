import { atom } from 'jotai';
import type { TReportContext } from './payload';

/** The error currently being reported; the shared `ReportHost` dialog opens while this is set. */
export const reportRequestAtom = atom<TReportContext | null>(null);

/** Request ids already reported in this session; one report per request id. */
export const reportedRequestsAtom = atom<ReadonlySet<string>>(new Set<string>());
