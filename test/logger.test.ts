import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, flush, init, log, metrics, type IngestLogRecord } from '../src/index';

describe('neptune-sdk-web', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('使用 baseURL 将批量日志发送到 /v2/logs:ingest，并对齐 contracts 字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const logger = createLogger({
      baseURL: 'https://gateway.example.com/api',
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    const record = logger.log({
      level: 'info',
      message: 'hello web sdk',
      category: 'ui',
      attributes: {
        count: 1,
        ok: true,
      },
    });

    expect(record.platform).toBe('web');
    expect(record.appId).toBe('app.web');
    expect(record.attributes).toEqual({ count: '1', ok: 'true' });

    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/v2/logs:ingest');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual([record]);
  });

  it('启用 discovery 后优先使用发现到的 host/port/version 发送日志', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        expect(url).toBe('https://bootstrap.example.com/v2/gateway/discovery');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            host: 'gateway-discovered.example.com',
            port: 19421,
            version: '2.0.0-alpha.1',
          }),
        };
      }

      return { ok: true, status: 202 };
    });

    const logger = createLogger({
      baseURL: 'https://bootstrap.example.com/api',
      discovery: {
        enabled: true,
      },
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    logger.log({
      level: 'info',
      message: 'via discovery',
      category: 'transport',
    });

    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gateway-discovered.example.com:19421/v2/logs:ingest');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
  });

  it('discovery 失败后按 dsn -> baseURL -> 默认 loopback 回退', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        throw new Error('discovery offline');
      }

      return { ok: true, status: 202 };
    });

    const logger = createLogger({
      baseURL: 'https://gateway.example.com/base',
      dsn: 'https://ingest.example.com/custom',
      discovery: {
        enabled: true,
        url: 'https://bootstrap.example.com/v2/gateway/discovery',
      },
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    logger.log({
      level: 'warning',
      message: 'fallback to dsn',
      category: 'transport',
    });

    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bootstrap.example.com/v2/gateway/discovery');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ingest.example.com/custom');
  });

  it('浏览器环境默认只尝试 same-origin discovery，不做 mDNS 扫描', async () => {
    vi.stubGlobal('window', {
      location: {
        origin: 'https://app.example.com',
      },
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        expect(url).toBe('https://app.example.com/v2/gateway/discovery');
        throw new Error('same-origin discovery unavailable');
      }

      return { ok: true, status: 202 };
    });

    const logger = createLogger({
      discovery: {
        enabled: true,
      },
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    logger.log({
      level: 'info',
      message: 'browser fallback',
      category: 'transport',
    });

    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://app.example.com/v2/gateway/discovery');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:18765/v2/logs:ingest');
  });

  it('队列超过 2000 时丢弃最旧日志并累计 dropped_overflow', async () => {
    const batches: IngestLogRecord[][] = [];
    let releaseFirstRequest: (() => void) | null = null;

    const fetchMock = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)));
      if (batches.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRequest = resolve;
        });
      }
      return { ok: true, status: 202 };
    });

    const logger = createLogger({
      dsn: 'https://ingest.example.com/custom',
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    for (let index = 0; index < 2055; index += 1) {
      logger.log({
        level: 'debug',
        message: `message-${index}`,
        category: 'queue',
      });
    }

    await Promise.resolve();

    expect(logger.metrics().queue_size).toBe(2000);
    expect(logger.metrics().dropped_overflow).toBe(5);

    releaseFirstRequest?.();
    await vi.runAllTicks();
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(41);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ingest.example.com/custom');
    expect(batches[0][0]?.message).toBe('message-0');
    expect(batches[1][0]?.message).toBe('message-55');
    expect(batches.at(-1)?.at(-1)?.message).toBe('message-2054');
  });

  it('达到 50 条时立即批量刷新，未达阈值时 1 秒触发定时刷新', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const logger = createLogger({
      baseURL: 'https://gateway.example.com',
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    for (let index = 0; index < 49; index += 1) {
      logger.log({
        level: 'info',
        message: `timer-${index}`,
        category: 'timer',
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toHaveLength(49);

    fetchMock.mockClear();

    for (let index = 0; index < 50; index += 1) {
      logger.log({
        level: 'info',
        message: `batch-${index}`,
        category: 'batch',
      });
    }

    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toHaveLength(50);
  });

  it('失败后按 0.5/1/2/4/8 秒指数退避，最多重试 5 次', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline-1'))
      .mockRejectedValueOnce(new Error('offline-2'))
      .mockRejectedValueOnce(new Error('offline-3'))
      .mockRejectedValueOnce(new Error('offline-4'))
      .mockRejectedValueOnce(new Error('offline-5'))
      .mockResolvedValueOnce({ ok: true, status: 202 });

    const logger = createLogger({
      baseURL: 'https://gateway.example.com',
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    logger.log({
      level: 'error',
      message: 'retry me',
      category: 'transport',
    });

    const pendingFlush = logger.flush();

    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(8000);
    await pendingFlush;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(logger.metrics().retry_total).toBe(5);
    expect(logger.metrics().sent_total).toBe(1);
  });

  it('支持 init + log + flush + metrics 单例 API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });

    init({
      baseURL: 'https://gateway.example.com',
      appId: 'app.web',
      sessionId: 'session-001',
      deviceId: 'device-001',
      fetch: fetchMock,
    });

    const record = log({
      level: 'notice',
      message: 'singleton',
      category: 'api',
    });

    expect(metrics().queue_size).toBe(1);

    await flush();

    expect(record.message).toBe('singleton');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metrics().sent_total).toBe(1);
  });
});
