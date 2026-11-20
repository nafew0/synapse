import { createHmac } from 'crypto';
import { verifyWebhookSignature } from './signature';

const secret = 'whsec_test';
const now = 1_800_000_000_000;
const body = Buffer.from('{"id":"e1","type":"subscription.limits_changed"}');

const sign = (key: string, timestamp: string, payload: Buffer = body) =>
  createHmac('sha256', key).update(`${timestamp}.`).update(payload).digest('hex');
const stamp = (offsetSeconds = 0) => String(Math.floor(now / 1000) + offsetSeconds);

function verify(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  const timestamp = stamp();
  return verifyWebhookSignature({
    secrets: [secret],
    timestamp,
    signature: `v1=${sign(secret, timestamp)}`,
    rawBody: body,
    nowMs: now,
    ...overrides,
  });
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('rejects an unsigned request', () => {
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: 'unsigned' });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: 'unsigned' });
  });

  it('rejects when no secret is configured, even with a signature made from the empty string', () => {
    const timestamp = stamp();
    expect(verify({ secrets: [], signature: `v1=${sign('', timestamp)}`, timestamp })).toEqual({
      ok: false,
      reason: 'no_secret_configured',
    });
  });

  it('rejects a stale timestamp (replay) and a far-future one', () => {
    for (const offset of [-301, 301, -86_400]) {
      const timestamp = stamp(offset);
      expect(verify({ timestamp, signature: `v1=${sign(secret, timestamp)}` })).toEqual({
        ok: false,
        reason: 'stale',
      });
    }
  });

  it('accepts the edge of the five-minute window', () => {
    const timestamp = stamp(-300);
    expect(verify({ timestamp, signature: `v1=${sign(secret, timestamp)}` })).toEqual({ ok: true });
  });

  it('rejects a body that changed after signing', () => {
    expect(verify({ rawBody: Buffer.from('{"id":"e1","type":"x"}') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects the signature of another secret, or of another timestamp', () => {
    const timestamp = stamp();
    expect(verify({ signature: `v1=${sign('other', timestamp)}` }).ok).toBe(false);
    expect(verify({ signature: `v1=${sign(secret, stamp(-1))}` }).ok).toBe(false);
  });

  it('rejects malformed timestamps and signatures without throwing', () => {
    expect(verify({ timestamp: '12abc' }).ok).toBe(false);
    expect(verify({ timestamp: '-5' }).ok).toBe(false);
    expect(verify({ signature: 'v1=zz' }).ok).toBe(false);
    expect(verify({ signature: 'v1=' }).ok).toBe(false);
    expect(verify({ signature: 'v2=abcd' }).ok).toBe(false);
    expect(verify({ signature: `v1=${'a'.repeat(63)}` }).ok).toBe(false);
  });

  it('accepts either of two v1 values during a secret rotation', () => {
    const timestamp = stamp();
    const header = `v1=${sign('newer', timestamp)},v1=${sign(secret, timestamp)}`;
    expect(verify({ signature: header, timestamp })).toEqual({ ok: true });
    expect(verify({ signature: header, timestamp, secrets: ['newer'] })).toEqual({ ok: true });
    expect(verify({ signature: header, timestamp, secrets: ['neither'] }).ok).toBe(false);
  });

  it('accepts a request signed with any configured secret', () => {
    expect(verify({ secrets: ['old', secret] })).toEqual({ ok: true });
  });
});
