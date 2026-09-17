import process from 'node:process';

const target = process.env.IPFX_LOAD_TEST_URL || 'http://127.0.0.1:4173/';
const url = new URL(target);
const isProduction = ['ipfxcapital.com', 'www.ipfxcapital.com'].includes(url.hostname);
if (isProduction && process.env.IPFX_ALLOW_PRODUCTION_LOAD_TEST !== 'true') {
  throw new Error('Production load testing is locked. Set IPFX_ALLOW_PRODUCTION_LOAD_TEST=true only in an approved window.');
}
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) targets are allowed.');

const concurrency = Math.min(50, Math.max(1, Number(process.env.IPFX_LOAD_CONCURRENCY) || 20));
const requestCount = Math.min(500, Math.max(concurrency, Number(process.env.IPFX_LOAD_REQUESTS) || 100));
const timeoutMs = Math.min(30_000, Math.max(1_000, Number(process.env.IPFX_LOAD_TIMEOUT_MS) || 10_000));
let cursor = 0;
const results = [];

async function worker() {
  while (cursor < requestCount) {
    cursor += 1;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      await response.arrayBuffer();
      results.push({ ok: response.ok, status: response.status, ms: performance.now() - started });
    } catch (error) {
      results.push({ ok: false, status: error?.name || 'ERROR', ms: performance.now() - started });
    } finally {
      clearTimeout(timer);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
const failures = results.filter(result => !result.ok);
const latency = results.map(result => result.ms).sort((a, b) => a - b);
const p95 = latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))];
console.log(JSON.stringify({ target: url.origin, requests: results.length, concurrency, failures: failures.length, p95_ms: Math.round(p95) }));
if (failures.length) process.exitCode = 1;

