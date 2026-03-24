# neptune-sdk-web

NeptuneKit v2 Web SDK，提供最小可用的浏览器日志采集能力。

## 能力

- 与 `neptune-contracts` 对齐的 `IngestLogRecord` 日志模型
- 内存队列上限 2000，溢出时丢弃最旧日志并累计 `dropped_overflow`
- 批量刷新策略：达到 50 条立即发送，或 1 秒定时发送
- 失败后按 `0.5 / 1 / 2 / 4 / 8s` 指数退避，最多重试 5 次
- 支持可选 `GET /v2/gateway/discovery`，成功后按发现到的 `host/port/version` 发送日志
- discovery 失败时按 `dsn -> baseURL -> 默认 loopback` 回退到 `/v2/logs:ingest`
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

### Discovery + 回退

```ts
import { createLogger } from 'neptune-sdk-web';

const logger = createLogger({
  discovery: {
    enabled: true,
    url: 'https://bootstrap.example.com/v2/gateway/discovery',
    timeoutMs: 1500,
  },
  dsn: 'https://gateway.example.com/v2/logs:ingest',
  appId: 'com.neptune.web',
  sessionId: 'session-001',
  deviceId: 'device-001',
});

logger.log({
  level: 'info',
  message: 'discovery first',
  category: 'bootstrap',
});

await logger.flush();
```

解析优先级：

1. 配置了 `discovery` 且 `enabled !== false` 时，先请求 `GET /v2/gateway/discovery`
2. discovery 成功：使用返回的 `host`、`port` 和 discovery 请求本身的协议，拼出 `/v2/logs:ingest`
3. discovery 失败：回退到手动配置，优先 `dsn`，其次 `baseURL`
4. 都未配置时：回退到默认 `http://127.0.0.1:18765/v2/logs:ingest`

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
  discovery?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
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

- `discovery`: 可选 discovery 配置。只要提供该对象且 `enabled !== false`，SDK 就会先尝试 `GET /v2/gateway/discovery`
- `discovery.url`: 显式 discovery 地址。适合部署 bootstrap 服务或反向代理
- `discovery.timeoutMs`: discovery 超时，默认 `1500`
- `dsn`: 完整 ingest 地址。discovery 失败后，优先级高于 `baseURL`
- `baseURL`: 网关基地址，SDK 会自动拼接 `/v2/logs:ingest`
- `fetch`: 自定义传输实现，便于 SSR、测试或运行时注入；如果启用 discovery，返回值还需要支持 `json()`

## 浏览器环境说明

浏览器环境不能像原生端那样做 mDNS / Bonjour 服务发现，也不应在 SDK 内做局域网网段扫描。

当前策略是：

1. 仅尝试显式提供的 `discovery.url`
2. 若未提供 `discovery.url`，则优先从 `baseURL` 或 `dsn` 推导 `/v2/gateway/discovery`
3. 如果都没有，再尝试浏览器当前页面的 same-origin `/v2/gateway/discovery`
4. 上述 discovery 失败后，再回退到 `dsn / baseURL / 默认 loopback`

推荐做法：

- Web 页面与 gateway 同源部署时，开启 `discovery.enabled`
- Web 页面跨域访问 gateway 时，显式传入 `discovery.url` 或直接配置 `dsn`
- 若 gateway 只监听本机 `127.0.0.1`，需确认浏览器环境允许访问本地 loopback，并处理好 CORS / mixed-content

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

## Demo 冒烟

仓库内提供了一个最小 Node demo，用于验证 `Web SDK -> Gateway -> 查询接口` 链路是否可用：

```bash
npm run build
NEPTUNE_GATEWAY_BASE_URL=http://127.0.0.1:18765 \
node examples/smoke-demo/run.cjs
```

脚本会：

- 发送 3 条 `platform=web` 的日志到 `/v2/logs:ingest`
- 调用 `/v2/logs` 验证按 `appId/sessionId` 可查回
- 调用 `/v2/sources` 和 `/v2/metrics` 验证聚合快照可读

默认 demo 标识：

- `appId`: `com.neptune.demo.web`
- `sessionId`: `smoke-<timestamp>`

## CI 与发包校验

GitHub Actions 会在 `push` 到 `main` 以及所有 `pull_request` 上自动执行：

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

其中 `npm pack --dry-run` 用于检查 npm 发包内容是否只包含预期产物，当前仓库会随 `dist/` 一起打包。
