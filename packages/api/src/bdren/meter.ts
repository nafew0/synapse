/** What a paid service (Firecrawl, OCR) needs from the allowance meter. Implemented in `/api`. */
export interface ServiceMeter {
  /** Whether the remaining allowance covers `credits` more. Always true when nothing is metered. */
  canAfford: (credits: number) => Promise<boolean>;
  /** Draws `credits` from the allowance. Idempotent on `key`, so a retry is never charged twice. */
  charge: (key: string, credits: number, label: string) => Promise<void>;
}

export const SERVICE_REFUSAL =
  'This service is unavailable because your usage allowance has been used up. It renews with your plan, or you can upgrade for more.';
