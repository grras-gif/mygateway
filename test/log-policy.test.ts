import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readLogPolicy, invalidateLogPolicyCache, resetLogPolicyCache } from '../src/gateway/log-policy.ts';
import type { Env } from '../src/env.ts';
import { recordRejectedRequest, recordRequestCompletion, type UsageRecordContext } from '../src/gateway/usage-recorder.ts';
import { asKV, FakeKV } from './helpers/fake-kv.ts';

// 32 zero bytes, base64 — a structurally valid MASTER_KEY for context encryption.
const MASTER_KEY = btoa('\0'.repeat(32));

const envOf = (fake: FakeKV) => ({ DB: asKV(fake), MASTER_KEY } as unknown as Env);

/** Every stored request log record. */
function logRecords(fake: FakeKV): Array<Record<string, unknown>> {
  return [...fake.store.entries()]
    .filter(([key]) => key.startsWith('request_log/'))
    .map(([, value]) => JSON.parse(value) as Record<string, unknown>);
}

/** First stored record under a key prefix. */
function firstRecord(fake: FakeKV, prefix: string): Record<string, unknown> | undefined {
  const entry = [...fake.store.entries()].find(([key]) => key.startsWith(prefix));
  return entry ? (JSON.parse(entry[1]) as Record<string, unknown>) : undefined;
}

function hasPrefix(fake: FakeKV, prefix: string): boolean {
  return [...fake.store.keys()].some((key) => key.startsWith(prefix));
}

const defaultPolicy = () => ({ logsEnabled: true, logSuccess: true, logErrors: true, logContext: false });

const ctx = (overrides: Partial<UsageRecordContext> = {}): UsageRecordContext => ({
  modelCardId: 'mc-1',
  unifiedModelId: 'deepseek-chat',
  channelId: 'ch-1',
  channelName: 'DeepSeek',
  inputPriceMicrosPerMillion: null,
  outputPriceMicrosPerMillion: null,
  cacheInputPriceMicrosPerMillion: null,
  attemptCount: 1,
  fallbackOccurred: false,
  stream: false,
  cached: false,
  keyId: 'key-1',
  keyName: 'test-key',
  requestId: 'req-1',
  policy: defaultPolicy(),
  ...overrides,
});

describe('log policy', () => {
  beforeEach(() => resetLogPolicyCache());
  afterEach(() => resetLogPolicyCache());

  test('missing settings default correctly (logContext=false, others=true)', async () => {
    const fake = new FakeKV();
    const db = asKV(fake);
    const policy = await readLogPolicy(db);
    expect(policy).toEqual({ logsEnabled: true, logSuccess: true, logErrors: true, logContext: false });
    expect(fake.reads).toBe(4); // one get per key
    await readLogPolicy(db);
    expect(fake.reads).toBe(4); // cached after the first read
  });

  test('invalidateLogPolicyCache forces a re-read after an admin update', async () => {
    const fake = new FakeKV()
      .seed('setting/request_logs_enabled', { value: 'true', updated_at: 1 })
      .seed('setting/log_success', { value: 'true', updated_at: 1 })
      .seed('setting/log_errors', { value: 'true', updated_at: 1 })
      .seed('setting/log_context', { value: 'false', updated_at: 1 });
    const db = asKV(fake);

    expect((await readLogPolicy(db)).logErrors).toBe(true);
    fake.seed('setting/log_errors', { value: 'false', updated_at: 2 });
    // cached → still true
    expect((await readLogPolicy(db)).logErrors).toBe(true);
    invalidateLogPolicyCache();
    expect((await readLogPolicy(db)).logErrors).toBe(false);
  });
});

describe('usage recorder level gating', () => {
  test('success rows are skipped when log_success is off', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { ...defaultPolicy(), logSuccess: false } }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      12,
    );
    expect(logRecords(fake)).toHaveLength(0);
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(true);
  });

  test('error rows are skipped when log_errors is off', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { ...defaultPolicy(), logErrors: false } }),
      'error',
      null,
      12,
      'upstream_http_500: boom',
    );
    expect(logRecords(fake)).toHaveLength(0);
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
  });

  test('all log rows skipped when request_logs_enabled is off', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { ...defaultPolicy(), logsEnabled: false } }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      12,
    );
    expect(logRecords(fake)).toHaveLength(0);
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(true);
  });

  test('error_detail is stored with error rows when enabled', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx(),
      'error',
      null,
      12,
      'upstream_http_502: bad gateway',
    );
    const logs = logRecords(fake);
    expect(logs).toHaveLength(1);
    expect(logs[0].error_detail).toBe('upstream_http_502: bad gateway');
  });

  test('rejected requests are gated by log_errors', async () => {
    const fake = new FakeKV();
    await recordRejectedRequest(
      envOf(fake),
      { keyId: 'key-1', keyName: 'k', requestId: 'r', model: 'm', modelCardId: null },
      'rate_limited',
      5,
      { ...defaultPolicy(), logErrors: false },
      'rpm_limit_exceeded',
    );
    expect(logRecords(fake)).toHaveLength(0);
  });

  test('rejected requests are gated by logsEnabled master switch', async () => {
    const fake = new FakeKV();
    await recordRejectedRequest(
      envOf(fake),
      { keyId: 'key-1', keyName: 'k', requestId: 'r', model: 'm', modelCardId: null },
      'rate_limited',
      5,
      { ...defaultPolicy(), logsEnabled: false },
      'rpm_limit_exceeded',
    );
    expect(logRecords(fake)).toHaveLength(0);
  });

  test('analytics always recorded even when all logs off', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { logsEnabled: false, logSuccess: false, logErrors: false, logContext: false } }),
      'success',
      { inputTokens: 100, outputTokens: 50 },
      200,
    );
    // analytics + key_daily_usage are always written; no request log.
    expect(logRecords(fake)).toHaveLength(0);
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(true);
  });

  test('provider cache hits are aggregated separately from total input tokens', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { ...defaultPolicy(), logsEnabled: false } }),
      'success',
      { inputTokens: 100, cacheTokens: 40, outputTokens: 25 },
      200,
    );
    const analytics = firstRecord(fake, 'analytics/');
    expect(analytics).toBeDefined();
    expect(analytics!.input_tokens).toBe(100);
    expect(analytics!.cache_input_tokens).toBe(40);
    expect(analytics!.output_tokens).toBe(25);
  });

  test('TTFT is recorded in analytics when stream=true', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ stream: true, ttftMs: 345 }),
      'success',
      { inputTokens: 50, outputTokens: 30 },
      500,
    );
    const analytics = firstRecord(fake, 'analytics/');
    expect(analytics).toBeDefined();
    expect(analytics!.ttft_ms_sum).toBe(345);
    expect(analytics!.ttft_ms_count).toBe(1);
  });

  test('TTFT not recorded for non-streaming requests', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ stream: false, ttftMs: undefined }),
      'success',
      { inputTokens: 50, outputTokens: 30 },
      500,
    );
    const analytics = firstRecord(fake, 'analytics/');
    expect(analytics).toBeDefined();
    expect(analytics!.ttft_ms_sum).toBe(0);
    expect(analytics!.ttft_ms_count).toBe(0);
  });

  test('context not written when log_context is off', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({
        policy: { ...defaultPolicy(), logContext: false },
        contextRequest: 'hello world',
        contextResponse: 'hi there',
      }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      12,
    );
    const logs = logRecords(fake);
    expect(logs).toHaveLength(1);
    for (const column of [
      'context_request_iv',
      'context_request_tag',
      'context_request_ciphertext',
      'context_response_iv',
      'context_response_tag',
      'context_response_ciphertext',
    ]) {
      expect(logs[0][column]).toBeNull();
    }
  });

  test('storage counts: completed with log = analytics + key usage + log', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: defaultPolicy() }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      12,
    );
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(true);
    expect(logRecords(fake)).toHaveLength(1);
  });

  test('storage counts: completed without log = analytics + key usage only', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ policy: { ...defaultPolicy(), logsEnabled: false } }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      12,
    );
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(true);
    expect(logRecords(fake)).toHaveLength(0);
  });

  test('storage counts: rejected with log = analytics + log', async () => {
    const fake = new FakeKV();
    await recordRejectedRequest(
      envOf(fake),
      { keyId: 'key-1', keyName: 'k', requestId: 'r', model: 'm', modelCardId: null },
      'rate_limited',
      5,
      defaultPolicy(),
      'rpm_limit_exceeded',
    );
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(hasPrefix(fake, 'key_usage/')).toBe(false);
    expect(logRecords(fake)).toHaveLength(1);
  });

  test('storage counts: rejected without log = analytics only', async () => {
    const fake = new FakeKV();
    await recordRejectedRequest(
      envOf(fake),
      { keyId: 'key-1', keyName: 'k', requestId: 'r', model: 'm', modelCardId: null },
      'rate_limited',
      5,
      { ...defaultPolicy(), logsEnabled: false },
      'rpm_limit_exceeded',
    );
    expect(hasPrefix(fake, 'analytics/')).toBe(true);
    expect(logRecords(fake)).toHaveLength(0);
  });

  test('request_logs includes ttft_ms and requested_protocol', async () => {
    const fake = new FakeKV();
    await recordRequestCompletion(
      envOf(fake),
      ctx({ stream: true, ttftMs: 123, requestedProtocol: 'openai_chat' }),
      'success',
      { inputTokens: 10, outputTokens: 5 },
      450,
    );
    const logs = logRecords(fake);
    expect(logs).toHaveLength(1);
    expect(logs[0].ttft_ms).toBe(123);
    expect(logs[0].requested_protocol).toBe('openai_chat');
  });

  test('rejected request_logs includes ttft_ms (null)', async () => {
    const fake = new FakeKV();
    await recordRejectedRequest(
      envOf(fake),
      { keyId: 'key-1', keyName: 'k', requestId: 'r', model: 'm', modelCardId: null },
      'rate_limited',
      5,
      defaultPolicy(),
      'rpm_limit_exceeded',
    );
    const logs = logRecords(fake);
    expect(logs).toHaveLength(1);
    expect(logs[0].ttft_ms).toBeNull();
  });
});
