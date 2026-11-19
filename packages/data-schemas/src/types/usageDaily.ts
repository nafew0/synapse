import type { Types } from 'mongoose';

export interface IUsageDaily {
  key: string;
  /** Asia/Dhaka calendar day, `YYYY-MM-DD`. */
  day: string;
  tenantId?: string;
  user?: Types.ObjectId;
  service: string;
  modelKey?: string;
  usageKind?: string;
  taskType?: string;
  billable: boolean;
  requests: number;
  units: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costUsd: number;
  rows: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITaskCostProfile {
  day: string;
  taskType: string;
  windowDays: number;
  requests: number;
  medianUsd: number;
  p90Usd: number;
  meanUsd: number;
  perPageUsd?: number;
  avgPages: number;
  avgWebCredits: number;
  avgImages: number;
  sufficient: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUsageJob {
  name: string;
  watermark?: Types.ObjectId;
  lockedUntil?: Date;
  lastRunAt?: Date;
  lastDay?: string;
}
