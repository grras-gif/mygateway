import { beforeEach, describe, expect, test } from 'vitest';
import { computeCostMicros, formatUsdMicros } from '../src/shared/cost.ts';
import { checkQuota, checkRpm, configureKeyQuota, keyIsExpired, resetKeyQuota } from '../src/gateway/key-quota.ts';
import type { GatewayKeyIdentity } from '../src/gateway/access-resolver.ts';
import { quotaWindow } from '../src/shared/key-limits.ts';
import {
  cleanupExpiredTemporaryGatewayKeys,
  listGatewayKeys,
  parseModelAllowlist,
  serializeModelAllowlist,
  toPublicKey,
  type GatewayKeyRow,
} from '../src/db/keys.ts';
import { asKV, FakeKV } from './helpers/fake-kv.ts';

const key = (overrides: Partial<GatewayKeyIdentity> = {}): GatewayKeyIdentity => ({
  id: 'key-1',
  name: 'default',
  rpmLimit: null,
  requestLimit: null,
  tokenLimit: null,
  limitPeriod: 'day',
  expiresAt: null,
  modelAllowlist: [],
  ...overrides,
});

const keyRow = (overrides: Partial<GatewayKeyRow> = {}): GatewayKeyRow => ({
  id: 'key-1',
  name: 'default',
  key_prefix: 'gw_test',
  key_hash: 'hash-1',
  status: 'active',
  rpm_limit: null,
  request_limit: null,
  token_limit: null,
  limit_period: 'day',
  expires_at: null,
  model_allowlist: null,
  created_at: 1,
  updated_at: 1,
  revoked_at: null,
  is_temporary: 0,
  ...overrides,
});

describe('cost math', () => {
  test('computes integer micro-USD without floating drift', () => {
    // $3 per M input, $15 per M output, 1_000 in + 500 out → 0.003 + 0.0075
    expect(computeCostMicros(1_000, 500, 3_000_000, 15_000_000)).toBe(10_500);
  });

  test('zero when no prices are configured', () => {
    expect(computeCostMicros(10_000, 10_000, null, null)).toBe(0);
    expect(computeCostMicros(0, 0, 3_000_000, 15_000_000)).toBe(0);
  });

  test('rounds sub-micro amounts', () => {
    expect(computeCostMicros(1, 0, 1_000_000, 1_000_000)).toBe(1);
    expect(computeCostMicros(1, 0, 100, 100)).toBe(0);
  });

  test('formats micro-USD', () => {
    expect(formatUsdMicros(10_500)).toBe('$0.010500');
    expect(formatUsdMicros(0)).toBe('$0.000000');
  });
});

describe('key quota', () => {
  const now = Date.UTC(2026, 7, 5, 12);

  beforeEach(() => {
    resetKeyQuota();
    configureKeyQuota(5_000);
  });

  test('expiry compares against unix seconds', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(keyIsExpired(key({ expiresAt: nowSeconds - 1 }), nowSeconds)).toBe(true);
    expect(keyIsExpired(key({ expiresAt: nowSeconds + 60 }), nowSeconds)).toBe(false);
    expect(keyIsExpired(key({ expiresAt: null }), nowSeconds)).toBe(false);
  });

  test('rpm gates within the current minute and resets on the next', () => {
    const identity = key({ rpmLimit: 2 });
    expect(checkRpm(identity.id, identity.rpmLimit)).toBe(true);
    expect(checkRpm(identity.id, identity.rpmLimit)).toBe(true);
    expect(checkRpm(identity.id, identity.rpmLimit)).toBe(false);
    // Different key is unaffected.
    expect(checkRpm('other-key', 2)).toBe(true);
    // No limit → always allowed.
    expect(checkRpm('unlimited-key', null)).toBe(true);
  });

  test('natural UTC windows cover day, ISO week, month, and year boundaries', () => {
    expect(quotaWindow('day', now)).toEqual({ period: 'day', startDate: '2026-08-05', endDate: '2026-08-06' });
    expect(quotaWindow('week', now)).toEqual({ period: 'week', startDate: '2026-08-03', endDate: '2026-08-10' });
    expect(quotaWindow('month', now)).toEqual({ period: 'month', startDate: '2026-08-01', endDate: '2026-09-01' });
    expect(quotaWindow('year', now)).toEqual({ period: 'year', startDate: '2026-01-01', endDate: '2027-01-01' });
  });

  test('period quota reads the KV usage window and blocks at configured limits', async () => {
    const fake = new FakeKV();
    const db = asKV(fake);

    const allowed = await checkQuota(db, key({
      id: 'limited', requestLimit: 1, limitPeriod: 'week',
    }), now);
    expect(allowed).toEqual({ allowed: true });
    expect(fake.lookups).toBe(1);

    fake.seed('key_usage:limited:2026-08-03', {
      key_id: 'limited', date: '2026-08-03', requests: 1, input_tokens: 0, output_tokens: 0, cost_micros: 0,
    });
    resetKeyQuota(); // simulate the refresh window elapsing → re-read KV
    const blocked = await checkQuota(db, key({
      id: 'limited', requestLimit: 1, limitPeriod: 'week',
    }), now);
    expect(blocked).toEqual({ allowed: false, reason: 'request_limit' });

    fake.seed('key_usage:tokens:2026-01-01', {
      key_id: 'tokens', date: '2026-01-01', requests: 0, input_tokens: 1_000, output_tokens: 500, cost_micros: 0,
    });
    resetKeyQuota();
    const tokenBlocked = await checkQuota(db, key({
      id: 'tokens', tokenLimit: 1_000, limitPeriod: 'year',
    }), now);
    expect(tokenBlocked).toEqual({ allowed: false, reason: 'token_limit' });
  });

  test('ledger reuses the KV snapshot and counts local bumps between refreshes', async () => {
    const fake = new FakeKV();
    const db = asKV(fake);
    const { bumpKeyQuotaLedger } = await import('../src/gateway/key-quota.ts');

    const identity = key({ id: 'busy', requestLimit: 3 });
    expect(await checkQuota(db, identity, now)).toEqual({ allowed: true });
    const lookupsAfterFirst = fake.lookups;

    // Completed requests bump the local ledger — no extra KV reads.
    bumpKeyQuotaLedger('busy', { requests: 1, inputTokens: 0, outputTokens: 0, costMicros: 0 });
    bumpKeyQuotaLedger('busy', { requests: 1, inputTokens: 0, outputTokens: 0, costMicros: 0 });
    expect(await checkQuota(db, identity, now)).toEqual({ allowed: true }); // 2 < 3
    bumpKeyQuotaLedger('busy', { requests: 1, inputTokens: 0, outputTokens: 0, costMicros: 0 });
    expect(await checkQuota(db, identity, now)).toEqual({ allowed: false, reason: 'request_limit' }); // 3 >= 3
    expect(fake.lookups).toBe(lookupsAfterFirst); // still the single KV read
  });

  test('coalesces concurrent cold-cache checks into one KV read', async () => {
    const fake = new FakeKV();
    const db = asKV(fake);
    const identity = key({ id: 'concurrent', tokenLimit: 1_000, limitPeriod: 'month' });
    await Promise.all([checkQuota(db, identity, now), checkQuota(db, identity, now)]);
    expect(fake.lookups).toBe(1);
  });

  test('period quota skips the KV read when no limits are set', async () => {
    const fake = new FakeKV();
    const db = asKV(fake);
    const decision = await checkQuota(db, key(), now);
    expect(decision).toEqual({ allowed: true });
    expect(fake.lookups).toBe(0);
  });
});

describe('model allowlist parsing', () => {
  test('round-trips through storage', () => {
    const serialized = serializeModelAllowlist(['deepseek-chat', 'gpt-4o', 'gpt-4o']);
    expect(serialized).toBe('["deepseek-chat","gpt-4o"]');
    expect(parseModelAllowlist(serialized)).toEqual(['deepseek-chat', 'gpt-4o']);
  });

  test('handles empty and malformed values', () => {
    expect(serializeModelAllowlist([])).toBeNull();
    expect(serializeModelAllowlist(undefined)).toBeNull();
    expect(parseModelAllowlist(null)).toEqual([]);
    expect(parseModelAllowlist('not-json')).toEqual([]);
  });
});

test('an explicitly cleared migrated budget does not fall back to stale legacy values', () => {
  const publicKey = toPublicKey({
    id: 'cleared', name: 'cleared', key_prefix: 'gw_clear', key_hash: 'hash', status: 'active',
    rpm_limit: null, request_limit: null, token_limit: null, limit_period: 'day',
    daily_request_limit: 100, daily_token_limit: 1_000, expires_at: null, model_allowlist: null,
    created_at: 1, updated_at: 1, revoked_at: null, is_temporary: 0,
  });
  expect(publicKey).toMatchObject({
    request_limit: null,
    token_limit: null,
    daily_request_limit: null,
    daily_token_limit: null,
  });
});

describe('temporary gateway key persistence', () => {
  test('listing hides expired temporary keys without dropping regular keys', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fake = new FakeKV()
      .seed('gateway_key:regular', keyRow({ id: 'regular', is_temporary: 0 }))
      .seed('gateway_key:temp-live', keyRow({
        id: 'temp-live', is_temporary: 1, expires_at: nowSeconds + 3_600,
      }))
      .seed('gateway_key:temp-expired', keyRow({
        id: 'temp-expired', is_temporary: 1, expires_at: nowSeconds - 1,
      }));

    const keys = await listGatewayKeys(asKV(fake));
    expect(keys.map((row) => row.id).sort()).toEqual(['regular', 'temp-live']);
  });

  test('lazy cleanup deletes only expired server-marked temporary keys', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fake = new FakeKV()
      .seed('gateway_key:regular', keyRow({ id: 'regular', is_temporary: 0 }))
      .seed('gateway_key:temp-live', keyRow({
        id: 'temp-live', is_temporary: 1, expires_at: nowSeconds + 3_600,
      }))
      .seed('gateway_key:temp-expired', keyRow({
        id: 'temp-expired', is_temporary: 1, expires_at: nowSeconds - 1,
      }));

    expect(await cleanupExpiredTemporaryGatewayKeys(asKV(fake))).toBe(1);
    expect(fake.store.has('gateway_key:temp-expired')).toBe(false);
    expect(fake.store.has('gateway_key:temp-live')).toBe(true);
    expect(fake.store.has('gateway_key:regular')).toBe(true);
  });
});
