import {
  SDK_NAME,
  SDK_VERSION,
  PLATFORM,
  ingestLogRecordSchema,
  logInputSchema,
  loggerConfigSchema,
  type IngestLogRecord,
  type FetchLike,
  type LogInput,
  type LoggerConfig,
  type LoggerMetricsSnapshot,
  type SourceOrigin,
} from './contracts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:18765';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_QUEUE_SIZE = 2_000;
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

type TimerHandle = ReturnType<typeof setTimeout>;

export type NeptuneLogger = {
  log(input: LogInput): IngestLogRecord;
  flush(): Promise<void>;
  metrics(): LoggerMetricsSnapshot;
};

export class NeptuneLoggerImpl implements NeptuneLogger {
  private readonly endpoint: string;
  private readonly fetcher: FetchLike;
  private readonly source: SourceOrigin;
  private readonly queue: IngestLogRecord[] = [];
  private flushTimer: TimerHandle | null = null;
  private activeFlush: Promise<void> | null = null;
  private readonly counters: Omit<LoggerMetricsSnapshot, 'queue_size'> = {
    dropped_overflow: 0,
    enqueued_total: 0,
    sent_total: 0,
    failed_total: 0,
    retry_total: 0,
  };

  constructor(config: LoggerConfig) {
    const parsedConfig = loggerConfigSchema.parse(config);
    this.endpoint = resolveEndpoint(parsedConfig);
    this.fetcher = parsedConfig.fetch ?? defaultFetch;
    this.source = {
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      ...parsedConfig.source,
    };
    this.context = {
      appId: parsedConfig.appId,
      sessionId: parsedConfig.sessionId,
      deviceId: parsedConfig.deviceId,
    };
  }

  private readonly context: Pick<IngestLogRecord, 'appId' | 'sessionId' | 'deviceId'>;

  log(input: LogInput): IngestLogRecord {
    const parsedInput = logInputSchema.parse(input);
    const record = ingestLogRecordSchema.parse({
      timestamp: normalizeTimestamp(parsedInput.timestamp),
      level: parsedInput.level,
      message: parsedInput.message,
      platform: PLATFORM,
      appId: this.context.appId,
      sessionId: this.context.sessionId,
      deviceId: this.context.deviceId,
      category: parsedInput.category,
      attributes: normalizeAttributes(parsedInput.attributes),
      source: mergeSource(this.source, parsedInput.source),
    });

    if (this.queue.length >= DEFAULT_MAX_QUEUE_SIZE) {
      this.queue.shift();
      this.counters.dropped_overflow += 1;
    }

    this.queue.push(record);
    this.counters.enqueued_total += 1;

    if (this.queue.length >= DEFAULT_BATCH_SIZE) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }

    return record;
  }

  flush(): Promise<void> {
    if (this.activeFlush) {
      return this.activeFlush;
    }

    this.clearFlushTimer();
    this.activeFlush = this.drainQueue().finally(() => {
      this.activeFlush = null;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    });

    return this.activeFlush;
  }

  metrics(): LoggerMetricsSnapshot {
    return {
      queue_size: this.queue.length,
      ...this.counters,
    };
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, DEFAULT_BATCH_SIZE);
      const sent = await this.sendBatch(batch);

      if (!sent) {
        this.queue.unshift(...batch);
        return;
      }
    }
  }

  private async sendBatch(batch: IngestLogRecord[]): Promise<boolean> {
    for (let retryIndex = 0; retryIndex <= RETRY_DELAYS_MS.length; retryIndex += 1) {
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(batch),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        this.counters.sent_total += batch.length;
        return true;
      } catch (error) {
        if (retryIndex === RETRY_DELAYS_MS.length) {
          this.counters.failed_total += batch.length;
          return false;
        }

        this.counters.retry_total += 1;
        await sleep(RETRY_DELAYS_MS[retryIndex]);
      }
    }

    return false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.queue.length === 0) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, DEFAULT_FLUSH_INTERVAL_MS);

    maybeUnrefTimer(this.flushTimer);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

function resolveEndpoint(config: LoggerConfig): string {
  if (config.dsn) {
    return ensureIngestPath(config.dsn).toString();
  }

  return new URL('/v2/logs:ingest', config.baseURL ?? DEFAULT_BASE_URL).toString();
}

function ensureIngestPath(input: string): URL {
  const url = new URL(input);
  if (url.pathname === '/' || url.pathname.length === 0) {
    url.pathname = '/v2/logs:ingest';
  }
  return url;
}

function mergeSource(defaultSource: SourceOrigin, override?: SourceOrigin): SourceOrigin {
  return {
    ...defaultSource,
    ...override,
  };
}

function normalizeTimestamp(timestamp?: string | Date): string {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }

  return timestamp ?? new Date().toISOString();
}

function normalizeAttributes(attributes?: LogInput['attributes']): Record<string, string> | undefined {
  if (!attributes) {
    return undefined;
  }

  const entries = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

async function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is not available; provide config.fetch explicitly');
  }

  return globalThis.fetch(input, init);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    maybeUnrefTimer(timer);
  });
}

function maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const timerWithUnref = timer as { unref?: () => void };
  if (typeof timerWithUnref.unref === 'function') {
    timerWithUnref.unref();
  }
}
