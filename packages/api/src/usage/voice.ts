import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { ServiceChargeResult } from './charges';
import type { ServerRequest } from '~/types';
import { recordServiceCharge, resolveServicePricing } from './charges';

const MINUTE_MS = 60_000;
const WAV_HEADER_BYTES = 44;
const WAV_BYTE_RATE_OFFSET = 28;
const WAV_DATA_FALLBACK_BYTES_PER_SECOND = 32_000;

/** Typical bytes per second of speech recorded by browsers and phones; used only when the provider reports no duration. */
const NOMINAL_BYTES_PER_SECOND: Record<string, number> = {
  webm: 6_000,
  ogg: 6_000,
  mp4: 16_000,
  m4a: 16_000,
  mp3: 16_000,
  mpeg: 16_000,
  flac: 60_000,
};

export interface AudioDurationInput {
  /** The length the provider's response states, when it does. */
  providerSeconds?: number;
  buffer: Buffer;
  mimetype: string;
}

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function wavSeconds(buffer: Buffer): number | undefined {
  if (buffer.length <= WAV_HEADER_BYTES || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return undefined;
  }
  const byteRate = buffer.readUInt32LE(WAV_BYTE_RATE_OFFSET) || WAV_DATA_FALLBACK_BYTES_PER_SECOND;
  return (buffer.length - WAV_HEADER_BYTES) / byteRate;
}

/**
 * Length of a recording in seconds: the provider's own figure first, then the WAV header, then an
 * estimate from the file size. The estimate can drift for compressed formats; the invoice check
 * (cost plan, phase 5) catches that.
 */
export function audioSeconds({ providerSeconds, buffer, mimetype }: AudioDurationInput): number {
  if (isPositive(providerSeconds)) {
    return providerSeconds;
  }
  const wav = wavSeconds(buffer);
  if (isPositive(wav)) {
    return wav;
  }
  const subtype = mimetype.split('/')[1]?.toLowerCase() ?? '';
  const format = Object.keys(NOMINAL_BYTES_PER_SECOND).find((key) => subtype.includes(key));
  return buffer.length / NOMINAL_BYTES_PER_SECOND[format ?? 'webm'];
}

export interface VoiceChargeInput extends AudioDurationInput {
  user: string;
  tenantId?: string;
  pricePerSecondUsd: number;
  now?: Date;
}

/**
 * Records one transcription as seconds of audio. Voice input is a user action, so it is billable.
 * The key is the audio's hash and the minute, so a replayed request is recorded once while the
 * same words said again later are charged again.
 */
export async function recordVoiceCharge({
  user,
  tenantId,
  pricePerSecondUsd,
  now = new Date(),
  ...audio
}: VoiceChargeInput): Promise<ServiceChargeResult> {
  try {
    return await recordVoiceChargeUnsafe({ user, tenantId, pricePerSecondUsd, now, ...audio });
  } catch (error) {
    logger.error('[Usage] Failed to record voice charge', error);
    return { recorded: false, costUsd: 0, credits: 0 };
  }
}

function recordVoiceChargeUnsafe({
  user,
  tenantId,
  pricePerSecondUsd,
  now,
  ...audio
}: VoiceChargeInput & { now: Date }): Promise<ServiceChargeResult> {
  const digest = createHash('sha256').update(audio.buffer).digest('hex').slice(0, 32);
  return recordServiceCharge({
    service: 'stt',
    usageKind: 'voice',
    usageUnit: 'seconds',
    units: audioSeconds(audio),
    unitPriceUsd: pricePerSecondUsd,
    user,
    tenantId,
    taskType: 'voice',
    requestKey: `stt:${user}:${digest}:${Math.floor(now.getTime() / MINUTE_MS)}`,
  });
}

/** Who a transcription is billed to: the signed-in user, at the price from `servicePricing`. */
export function getVoiceCharge(
  req?: Pick<ServerRequest, 'user' | 'config'>,
): Pick<VoiceChargeInput, 'user' | 'tenantId' | 'pricePerSecondUsd'> | undefined {
  if (!req?.user?.id) {
    return undefined;
  }
  return {
    user: req.user.id,
    tenantId: req.user.tenantId,
    pricePerSecondUsd: resolveServicePricing(req.config?.servicePricing).stt.pricePerSecondUsd,
  };
}
