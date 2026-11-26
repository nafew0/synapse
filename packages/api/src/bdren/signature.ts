import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export interface VerifyParams {
  secrets: string[];
  timestamp: string | undefined;
  signature: string | undefined;
  /** The bytes as received. Parsing and re-serialising the body would change them. */
  rawBody: Buffer;
  nowMs?: number;
}

function hmacHex(secret: string, timestamp: string, body: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
}

/** The `v1=` values of the header; two are sent while a secret is being rotated. */
function signaturesOf(header: string): Buffer[] {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .filter((hex) => /^[0-9a-f]{64}$/i.test(hex))
    .map((hex) => Buffer.from(hex, 'hex'));
}

/**
 * Checks a bdren.ai webhook: the timestamp is within five minutes, and some `v1` value equals
 * HMAC-SHA256(secret, "<timestamp>." + raw body) for some configured secret. Comparison is constant
 * time and visits every candidate, so a mismatch reveals nothing about which one was close.
 */
export function verifyWebhookSignature(params: VerifyParams): SignatureResult {
  const { secrets, timestamp, signature, rawBody, nowMs = Date.now() } = params;
  if (secrets.length === 0) {
    return { ok: false, reason: 'no_secret_configured' };
  }
  if (!timestamp || !signature) {
    return { ok: false, reason: 'unsigned' };
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const candidates = signaturesOf(signature);
  if (candidates.length === 0) {
    return { ok: false, reason: 'bad_signature' };
  }
  let matched = false;
  for (const secret of secrets) {
    const expected = hmacHex(secret, timestamp, rawBody);
    for (const candidate of candidates) {
      matched = timingSafeEqual(expected, candidate) || matched;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
