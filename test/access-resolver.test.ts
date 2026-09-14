import { beforeEach, describe, expect, test } from 'vitest';
import {
  authenticateGatewayKeyHash,
  resetGatewayAccessCaches,
  resolveGatewayAccess,
} from '../src/gateway/access-resolver.ts';
import { asKV, FakeKV } from './helpers/fake-kv.ts';

const KEY_ROW = {
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
};

const MODEL_CARD = {
  id: 'model-card-1',
  unified_model_id: 'unified-model',
  display_name: 'Unified Model',
  status: 'active',
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};

const CHANNEL_MODEL = {
  id: 'channel-model-1',
  model_card_id: 'model-card-1',
  channel_id: 'channel-1',
  channel_model_id: 'provider-model-1',
  public_model_alias: 'provider-model-1@primary',
  sort_order: 0,
  status: 'active',
  supports_stream_usage: 1,
  input_price_micros_per_million: null,
  output_price_micros_per_million: null,
  cache_input_price_micros_per_million: null,
  currency: null,
  plan_tokens_total: null,
  plan_tokens_remaining: null,
  plan_expires_at: null,
  manual_metadata_updated_at: null,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};

const CHANNEL = {
  id: 'channel-1',
  name: 'Primary',
  provider_type: 'openai_compatible',
  base_url: 'https://provider.example/v1',
  api_key_ciphertext: 'ciphertext',
  api_key_iv: 'iv',
  api_key_version: 1,
  status: 'active',
  notes: null,
  preset_id: null,
  short_code: null,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};

const PROTOCOL = {
  channel_id: 'channel-1',
  protocol: 'openai_chat',
  base_url: 'https://provider.example/v1',
  auth_scheme: 'bearer',
  api_version: null,
};

function seededFake(): FakeKV {
  return new FakeKV()
    .seedRaw('gateway_key_hash:hash-1', 'key-1')
    .seed('gateway_key:key-1', KEY_ROW)
    .seed('model_identifier:unified-model', {
      identifier: 'unified-model',
      identifier_type: 'unified',
      model_card_id: 'model-card-1',
      channel_model_id: null,
    })
    .seed('model_card:model-card-1', MODEL_CARD)
    .seed('channel_model:channel-model-1', CHANNEL_MODEL)
    .seed('channel:channel-1', CHANNEL)
    .seed('channel_protocol:channel-1:openai_chat', PROTOCOL);
}

describe('gateway access resolver', () => {
  beforeEach(() => resetGatewayAccessCaches());

  test('resolves key authentication and model routing on a cold cache', async () => {
    const fake = seededFake();
    const db = asKV(fake);

    const first = await resolveGatewayAccess(db, 'hash-1', 'unified-model');
    expect(first.key).toEqual({
      id: 'key-1',
      name: 'default',
      rpmLimit: null,
      requestLimit: null,
      tokenLimit: null,
      limitPeriod: 'day',
      expiresAt: null,
      modelAllowlist: [],
    });
    expect(first.model.status).toBe('resolved');
    expect(first.metrics).toMatchObject({
      cacheStatus: 'miss',
      keyCache: 'miss',
      modelCache: 'miss',
      d1Statements: 2,
    });

    const readsAfterFirst = fake.reads;
    const second = await resolveGatewayAccess(db, 'hash-1', 'unified-model');
    expect(second.key).toEqual(first.key);
    expect(second.model).toEqual(first.model);
    expect(second.metrics).toMatchObject({
      cacheStatus: 'hit',
      keyCache: 'hit',
      modelCache: 'hit',
      d1Statements: 0,
      d1Ms: 0,
    });
    expect(fake.reads).toBe(readsAfterFirst);
  });

  test('fetches only the missing route after authentication is cached', async () => {
    const fake = seededFake();
    const db = asKV(fake);

    await expect(authenticateGatewayKeyHash(db, 'hash-1')).resolves.toEqual({
      id: 'key-1',
      name: 'default',
      rpmLimit: null,
      requestLimit: null,
      tokenLimit: null,
      limitPeriod: 'day',
      expiresAt: null,
      modelAllowlist: [],
    });
    const readsAfterAuth = fake.reads;
    const result = await resolveGatewayAccess(db, 'hash-1', 'unified-model');

    expect(result.model.status).toBe('resolved');
    expect(result.metrics).toMatchObject({
      cacheStatus: 'partial',
      keyCache: 'hit',
      modelCache: 'miss',
      d1Statements: 1,
    });
    expect(fake.reads).toBeGreaterThan(readsAfterAuth);
  });

  test('negative-caches an invalid key and skips route queries', async () => {
    const fake = seededFake();
    const db = asKV(fake);

    const first = await resolveGatewayAccess(db, 'invalid-hash', 'unified-model');
    const second = await resolveGatewayAccess(db, 'invalid-hash', 'another-model');

    expect(first.key).toBeNull();
    expect(second.key).toBeNull();
    expect(first.metrics).toMatchObject({ cacheStatus: 'miss', d1Statements: 2 });
    expect(second.metrics).toMatchObject({
      cacheStatus: 'hit',
      keyCache: 'hit',
      modelCache: 'skipped',
      d1Statements: 0,
      d1Ms: 0,
    });

    const readsBefore = fake.reads;
    fake.seedRaw('gateway_key_hash:new-valid-hash', 'key-1');
    await resolveGatewayAccess(db, 'new-valid-hash', 'unified-model');
    // Invalid callers never seed the route cache, so the new caller still reads both.
    expect(fake.reads).toBeGreaterThan(readsBefore);
  });

  test('distinguishes an unknown model from an unavailable model', async () => {
    const fake = seededFake();
    const db = asKV(fake);

    const missing = await resolveGatewayAccess(db, 'hash-1', 'missing-model');
    expect(missing.model).toEqual({ status: 'not_found' });
  });
});
