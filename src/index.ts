export {
  LOG_LEVELS,
  PLATFORM,
  SDK_NAME,
  SDK_VERSION,
  type IngestLogRecord,
  type LogInput,
  type LogLevel,
  type LoggerConfig,
  type LoggerMetricsSnapshot,
  type SourceOrigin,
} from './contracts';
import { type LogInput, type LoggerConfig, type LoggerMetricsSnapshot } from './contracts';
import { NeptuneLoggerImpl, type NeptuneLogger } from './logger';

let defaultLogger: NeptuneLogger | null = null;

export type { NeptuneLogger } from './logger';

export function createLogger(config: LoggerConfig): NeptuneLogger {
  return new NeptuneLoggerImpl(config);
}

export function init(config: LoggerConfig): NeptuneLogger {
  defaultLogger = createLogger(config);
  return defaultLogger;
}

export function log(input: LogInput) {
  return getLogger().log(input);
}

export function flush(): Promise<void> {
  return getLogger().flush();
}

export function metrics(): LoggerMetricsSnapshot {
  return getLogger().metrics();
}

function getLogger(): NeptuneLogger {
  if (!defaultLogger) {
    throw new Error('Logger has not been initialized. Call init(config) first.');
  }

  return defaultLogger;
}
