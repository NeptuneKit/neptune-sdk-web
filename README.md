# neptune-sdk-web

NeptuneKit v2 Web SDK，提供最小可用的浏览器日志采集能力。

## 能力

- 与 `neptune-contracts` 对齐的 `IngestLogRecord` 日志模型
- 内存队列上限 2000，溢出时丢弃最旧日志并累计 `dropped_overflow`
- 批量刷新策略：达到 50 条立即发送，或 1 秒定时发送
- 失败后按 `0.5 / 1 / 2 / 4 / 8s` 指数退避，最多重试 5 次
- 默认发送到 `/v2/logs:ingest`，支持 `dsn` 或 `baseURL` 配置
- 同时支持实例 API `createLogger()` 和单例 API `init() + log() + flush() + metrics()`

## 安装

```bash
npm install neptune-sdk-web
```

## 用法

### 实例 API

```ts
import { createLogger } from 'neptune-sdk-web';

const logger = createLogger({
  baseURL: 'https://gateway.example.com',
  appId: 'com.neptune.web',
  sessionId: 'session-001',
  deviceId: 'device-001',
});

logger.log({
  level: 'info',
  message: 'page loaded',
  category: 'lifecycle',
  attributes: {
    route: '/home',
    coldStart: true,
  },
});

await logger.flush();
console.log(logger.metrics());
```

### 单例 API

```ts
import { flush, init, log, metrics } from 'neptune-sdk-web';

init({
  dsn: 'https://gateway.example.com/v2/logs:ingest',
  appId: 'com.neptune.web',
  sessionId: 'session-001',
  deviceId: 'device-001',
});

log({
  level: 'error',
  message: 'request failed',
  category: 'network',
  attributes: {
    status: 503,
    retryable: true,
  },
});

await flush();
console.log(metrics());
```

## 配置

```ts
type LoggerConfig = {
  appId: string;
  sessionId: string;
  deviceId: string;
  baseURL?: string;
  dsn?: string;
  source?: {
    sdkName?: string;
    sdkVersion?: string;
    file?: string;
    function?: string;
    line?: number;
  };
  fetch?: typeof fetch;
};
```

- `dsn`: 完整 ingest 地址，优先级高于 `baseURL`
- `baseURL`: 网关基地址，SDK 会自动拼接 `/v2/logs:ingest`
- `fetch`: 自定义传输实现，便于 SSR、测试或运行时注入

## API

```ts
const logger = createLogger(config);
logger.log(input);
await logger.flush();
logger.metrics();

init(config);
log(input);
await flush();
metrics();
```

`metrics()` 返回：

```ts
{
  queue_size: number;
  dropped_overflow: number;
  enqueued_total: number;
  sent_total: number;
  failed_total: number;
  retry_total: number;
}
```

## 开发

```bash
npm test
npm run build
```
