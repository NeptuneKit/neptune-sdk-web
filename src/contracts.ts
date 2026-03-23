import { z } from 'zod';

export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
] as const;

export const PLATFORM = 'web' as const;
export const SDK_NAME = 'neptune-sdk-web';
export const SDK_VERSION = '0.1.0';

export type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;

export const logLevelSchema = z.enum(LOG_LEVELS);

export const sourceOriginSchema = z
  .object({
    sdkName: z.string().optional(),
    sdkVersion: z.string().optional(),
    file: z.string().optional(),
    function: z.string().optional(),
    line: z.number().int().optional(),
  })
  .strict();

export const ingestLogRecordSchema = z
  .object({
    timestamp: z.string().datetime(),
    level: logLevelSchema,
    message: z.string().min(1),
    platform: z.literal(PLATFORM),
    appId: z.string().min(1),
    sessionId: z.string().min(1),
    deviceId: z.string().min(1),
    category: z.string().min(1),
    attributes: z.record(z.string()).optional(),
    source: sourceOriginSchema.nullish(),
  })
  .strict();

export const loggerConfigSchema = z
  .object({
    appId: z.string().min(1),
    sessionId: z.string().min(1),
    deviceId: z.string().min(1),
    baseURL: z.string().url().optional(),
    dsn: z.string().url().optional(),
    source: sourceOriginSchema.optional(),
    fetch: z.custom<FetchLike>((value) => value === undefined || typeof value === 'function').optional(),
  })
  .strict();

export const logInputSchema = z
  .object({
    timestamp: z.union([z.string().datetime(), z.date()]).optional(),
    level: logLevelSchema,
    message: z.string().min(1),
    category: z.string().min(1),
    attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])).optional(),
    source: sourceOriginSchema.optional(),
  })
  .strict();

export type LogLevel = z.infer<typeof logLevelSchema>;
export type SourceOrigin = z.infer<typeof sourceOriginSchema>;
export type IngestLogRecord = z.infer<typeof ingestLogRecordSchema>;
export type LoggerConfig = z.infer<typeof loggerConfigSchema>;
export type LogInput = z.infer<typeof logInputSchema>;

export type LoggerMetricsSnapshot = {
  queue_size: number;
  dropped_overflow: number;
  enqueued_total: number;
  sent_total: number;
  failed_total: number;
  retry_total: number;
};
