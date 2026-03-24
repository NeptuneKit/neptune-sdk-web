#!/usr/bin/env node

'use strict';

const { createLogger } = require('../../dist/index.cjs');

if (typeof fetch !== 'function') {
  throw new Error('Node runtime does not provide fetch. Use Node.js 18+ to run smoke demo.');
}

async function main() {
  const baseURL = process.env.NEPTUNE_GATEWAY_BASE_URL || 'http://127.0.0.1:18765';
  const appId = process.env.NEPTUNE_DEMO_APP_ID || 'com.neptune.demo.web';
  const sessionId = process.env.NEPTUNE_DEMO_SESSION_ID || `smoke-${Date.now()}`;
  const deviceId = process.env.NEPTUNE_DEMO_DEVICE_ID || 'demo-web-device';
  const minRecords = Number(process.env.NEPTUNE_DEMO_MIN_RECORDS || '3');

  const logger = createLogger({
    baseURL,
    appId,
    sessionId,
    deviceId,
    source: {
      sdkName: 'neptune-sdk-web-demo',
      sdkVersion: '0.1.0',
      file: 'examples/smoke-demo/run.cjs',
      function: 'main',
      line: 1,
    },
  });

  const samples = [
    {
      level: 'info',
      message: 'demo smoke boot',
      category: 'lifecycle',
      attributes: { phase: 'boot' },
    },
    {
      level: 'notice',
      message: 'demo smoke interaction',
      category: 'interaction',
      attributes: { phase: 'tap' },
    },
    {
      level: 'warning',
      message: 'demo smoke transient warning',
      category: 'network',
      attributes: { retryable: true },
    },
  ];

  for (const item of samples) {
    logger.log(item);
  }

  await logger.flush();

  const loggerMetrics = logger.metrics();
  if (loggerMetrics.sent_total < samples.length) {
    throw new Error(`expected sent_total >= ${samples.length}, got ${loggerMetrics.sent_total}`);
  }

  const logsURL = new URL('/v2/logs', baseURL);
  logsURL.searchParams.set('platform', 'web');
  logsURL.searchParams.set('appId', appId);
  logsURL.searchParams.set('sessionId', sessionId);
  logsURL.searchParams.set('limit', '50');

  const logsResponse = await fetch(logsURL);
  if (!logsResponse.ok) {
    throw new Error(`query logs failed: ${logsResponse.status}`);
  }

  const logsPayload = await logsResponse.json();
  const records = Array.isArray(logsPayload.records)
    ? logsPayload.records
    : Array.isArray(logsPayload.items)
      ? logsPayload.items
      : [];
  if (records.length < minRecords) {
    throw new Error(`expected >= ${minRecords} queried records, got ${records.length}`);
  }

  const sourcesURL = new URL('/v2/sources', baseURL);
  const sourcesResponse = await fetch(sourcesURL);
  if (!sourcesResponse.ok) {
    throw new Error(`query sources failed: ${sourcesResponse.status}`);
  }
  const sourcesPayload = await sourcesResponse.json();
  const sources = Array.isArray(sourcesPayload.items) ? sourcesPayload.items : [];

  const metricsURL = new URL('/v2/metrics', baseURL);
  const metricsResponse = await fetch(metricsURL);
  if (!metricsResponse.ok) {
    throw new Error(`query metrics failed: ${metricsResponse.status}`);
  }
  const gatewayMetrics = await metricsResponse.json();

  const summary = {
    baseURL,
    appId,
    sessionId,
    queried_records: records.length,
    source_count: sources.length,
    logger_metrics: loggerMetrics,
    gateway_metrics: gatewayMetrics,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[smoke-demo] ${error.message}\n`);
  process.exit(1);
});
