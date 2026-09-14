import { beforeEach, describe, expect, test } from 'vitest';
import { BodyTooLargeError, readLimitedBody } from '../src/http/body-limit.ts';
import {
  MEBIBYTE,
  parseMaxRequestBodyMiB,
  readMaxRequestBytes,
  resetRuntimeSettingsCache,
} from '../src/gateway/runtime-settings.ts';
import { asKV, FakeKV } from './helpers/fake-kv.ts';

function fakeSettingsDb(value: string | null) {
  const fake = new FakeKV();
  if (value !== null) {
    fake.seed('setting/max_request_body_bytes', { value, updated_at: 1 });
  }
  return { db: asKV(fake), reads: () => fake.reads };
}

describe('gateway runtime settings', () => {
  beforeEach(() => resetRuntimeSettingsCache());

  test('accepts integer request limits from 16 through 64 MiB', () => {
    expect(parseMaxRequestBodyMiB(16)).toBe(16);
    expect(parseMaxRequestBodyMiB('64')).toBe(64);
    expect(() => parseMaxRequestBodyMiB(15)).toThrow(/between 16 and 64/);
    expect(() => parseMaxRequestBodyMiB(65)).toThrow(/between 16 and 64/);
    expect(() => parseMaxRequestBodyMiB(16.5)).toThrow(/between 16 and 64/);
  });

  test('uses the deployment fallback when unset and caches the result per isolate', async () => {
    const source = fakeSettingsDb(null);
    expect(await readMaxRequestBytes(source.db, 24 * MEBIBYTE)).toBe(24 * MEBIBYTE);
    expect(await readMaxRequestBytes(source.db, 32 * MEBIBYTE)).toBe(24 * MEBIBYTE);
    expect(source.reads()).toBe(1);
  });

  test('uses a valid stored setting and ignores an out-of-range stored value', async () => {
    const stored = fakeSettingsDb(String(64 * MEBIBYTE));
    expect(await readMaxRequestBytes(stored.db, 16 * MEBIBYTE)).toBe(64 * MEBIBYTE);

    resetRuntimeSettingsCache();
    const invalid = fakeSettingsDb(String(65 * MEBIBYTE));
    expect(await readMaxRequestBytes(invalid.db, 16 * MEBIBYTE)).toBe(16 * MEBIBYTE);

    resetRuntimeSettingsCache();
    const invalidFallback = fakeSettingsDb(null);
    expect(await readMaxRequestBytes(invalidFallback.db, 128 * MEBIBYTE)).toBe(16 * MEBIBYTE);

    resetRuntimeSettingsCache();
    const fractionalFallback = fakeSettingsDb(null);
    expect(await readMaxRequestBytes(fractionalFallback.db, 20_000_000)).toBe(16 * MEBIBYTE);
  });
});

describe('request body limit', () => {
  test('rejects a declared body larger than the configured limit', async () => {
    const request = new Request('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Length': '5' },
      body: 'data',
    });
    await expect(readLimitedBody(request, 4, 'req-1')).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  test('rejects an undeclared body once streamed bytes cross the limit', async () => {
    const request = new Request('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      body: 'image-data',
    });
    await expect(readLimitedBody(request, 5, 'req-2')).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
