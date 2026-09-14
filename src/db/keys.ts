/**
 * Gateway API Key operations, including virtual-key limits (KV-backed).
 */

import type { LimitPeriod } from '../shared/key-limits.ts';
import { gatewayKeyByHashKey, gatewayKeyKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';

export interface GatewayKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  status: 'active' | 'disabled';
  rpm_limit: number | null;
  daily_request_limit?: number | null;
  daily_token_limit?: number | null;
  request_limit: number | null;
  token_limit: number | null;
  limit_period: LimitPeriod;
  expires_at: number | null;
  model_allowlist: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  is_temporary: 0 | 1;
}

export interface GatewayKeyLimits {
  rpmLimit: number | null;
  requestLimit: number | null;
  tokenLimit: number | null;
  limitPeriod: LimitPeriod;
  expiresAt: number | null;
  modelAllowlist: string[];
}

/** Key as returned to admin API (no hash). */
export interface GatewayKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  status: 'active' | 'disabled';
  rpm_limit: number | null;
  request_limit: number | null;
  token_limit: number | null;
  limit_period: LimitPeriod;
  /** @deprecated Use request_limit with limit_period='day'. */
  daily_request_limit: number | null;
  /** @deprecated Use token_limit with limit_period='day'. */
  daily_token_limit: number | null;
  expires_at: number | null;
  model_allowlist: string[];
  created_at: number;
  updated_at: number;
  is_temporary: boolean;
}

export function toPublicKey(row: GatewayKeyRow): GatewayKeyPublic {
  const requestLimit = row.request_limit === undefined ? row.daily_request_limit ?? null : row.request_limit;
  const tokenLimit = row.token_limit === undefined ? row.daily_token_limit ?? null : row.token_limit;
  const limitPeriod = row.limit_period ?? 'day';
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    status: row.status,
    rpm_limit: row.rpm_limit,
    request_limit: requestLimit,
    token_limit: tokenLimit,
    limit_period: limitPeriod,
    daily_request_limit: limitPeriod === 'day' ? requestLimit : null,
    daily_token_limit: limitPeriod === 'day' ? tokenLimit : null,
    expires_at: row.expires_at,
    model_allowlist: parseModelAllowlist(row.model_allowlist),
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_temporary: row.is_temporary === 1,
  };
}

/** Parse a stored allowlist (JSON array of unified model ids). */
export function parseModelAllowlist(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/** Serialize an allowlist for storage (null when empty). */
export function serializeModelAllowlist(models: string[] | undefined): string | null {
  if (!models || models.length === 0) return null;
  return JSON.stringify([...new Set(models.map((item) => item.trim()).filter(Boolean))]);
}

function isVisible(row: GatewayKeyRow, nowSeconds: number): boolean {
  if (row.is_temporary !== 1) return true;
  if (row.expires_at === null || row.expires_at === undefined) return true;
  return row.expires_at > nowSeconds;
}

export async function listGatewayKeys(db: KVNamespace): Promise<GatewayKeyRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await kvListJson<GatewayKeyRow>(db, KEY_PREFIX.gatewayKey);
  return rows
    .filter((row) => isVisible(row, now))
    .sort((a, b) => b.created_at - a.created_at);
}

export async function createGatewayKey(
  db: KVNamespace,
  key: {
    id: string;
    name: string;
    key_prefix: string;
    key_hash: string;
    rpm_limit?: number | null;
    request_limit?: number | null;
    token_limit?: number | null;
    limit_period?: LimitPeriod;
    expires_at?: number | null;
    model_allowlist?: string | null;
    is_temporary?: boolean;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row: GatewayKeyRow = {
    id: key.id,
    name: key.name,
    key_prefix: key.key_prefix,
    key_hash: key.key_hash,
    status: 'active',
    rpm_limit: key.rpm_limit ?? null,
    request_limit: key.request_limit ?? null,
    token_limit: key.token_limit ?? null,
    limit_period: key.limit_period ?? 'day',
    expires_at: key.expires_at ?? null,
    model_allowlist: key.model_allowlist ?? null,
    created_at: now,
    updated_at: now,
    revoked_at: null,
    is_temporary: key.is_temporary ? 1 : 0,
  };
  await kvPutJson(db, gatewayKeyKey(key.id), row);
  await db.put(gatewayKeyByHashKey(key.key_hash), key.id);
}

export async function getGatewayKey(db: KVNamespace, id: string): Promise<GatewayKeyRow | null> {
  return kvGetJson<GatewayKeyRow>(db, gatewayKeyKey(id));
}

export async function cleanupExpiredTemporaryGatewayKeys(db: KVNamespace): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await kvListJson<GatewayKeyRow>(db, KEY_PREFIX.gatewayKey);
  const expired = rows.filter(
    (row) => row.is_temporary === 1 && row.expires_at !== null && row.expires_at <= now,
  );
  for (const row of expired) {
    await kvDelete(db, gatewayKeyKey(row.id));
    await kvDelete(db, gatewayKeyByHashKey(row.key_hash));
  }
  return expired.length;
}

/**
 * Lookup an active key by its hash. Used for gateway auth.
 */
export async function findActiveKeyByHash(
  db: KVNamespace,
  keyHash: string,
): Promise<Pick<GatewayKeyRow, 'id' | 'name'> | null> {
  const id = await db.get(gatewayKeyByHashKey(keyHash));
  if (!id) return null;
  const row = await getGatewayKey(db, id);
  if (!row || row.status !== 'active' || row.revoked_at !== null) return null;
  return { id: row.id, name: row.name };
}

/** Key identity used by the gateway hot path (single hash lookup). */
export async function getGatewayKeyIdentityByHash(
  db: KVNamespace,
  keyHash: string,
): Promise<GatewayKeyLimits & { id: string; name: string } | null> {
  const id = await db.get(gatewayKeyByHashKey(keyHash));
  if (!id) return null;
  const row = await getGatewayKey(db, id);
  if (!row || row.status !== 'active' || row.revoked_at !== null) return null;
  return {
    id: row.id,
    name: row.name,
    rpmLimit: row.rpm_limit ?? null,
    requestLimit: row.request_limit ?? null,
    tokenLimit: row.token_limit ?? null,
    limitPeriod: row.limit_period ?? 'day',
    expiresAt: row.expires_at ?? null,
    modelAllowlist: parseModelAllowlist(row.model_allowlist),
  };
}

export async function updateGatewayKeyStatus(
  db: KVNamespace,
  id: string,
  status: 'active' | 'disabled',
): Promise<void> {
  const row = await getGatewayKey(db, id);
  if (!row) return;
  row.status = status;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, gatewayKeyKey(id), row);
}

export async function updateGatewayKeyName(db: KVNamespace, id: string, name: string): Promise<void> {
  const row = await getGatewayKey(db, id);
  if (!row) return;
  row.name = name;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, gatewayKeyKey(id), row);
}

export async function updateGatewayKeyLimits(
  db: KVNamespace,
  id: string,
  limits: {
    rpm_limit?: number | null;
    request_limit?: number | null;
    token_limit?: number | null;
    limit_period?: LimitPeriod;
    expires_at?: number | null;
    model_allowlist?: string | null;
  },
): Promise<void> {
  const row = await getGatewayKey(db, id);
  if (!row) return;
  if (limits.rpm_limit !== undefined) row.rpm_limit = limits.rpm_limit;
  if (limits.request_limit !== undefined) row.request_limit = limits.request_limit;
  if (limits.token_limit !== undefined) row.token_limit = limits.token_limit;
  if (limits.limit_period !== undefined) row.limit_period = limits.limit_period;
  if (limits.expires_at !== undefined) row.expires_at = limits.expires_at;
  if (limits.model_allowlist !== undefined) row.model_allowlist = limits.model_allowlist;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, gatewayKeyKey(id), row);
}

export async function revokeGatewayKey(db: KVNamespace, id: string): Promise<void> {
  const row = await getGatewayKey(db, id);
  if (!row) return;
  const now = Math.floor(Date.now() / 1000);
  row.revoked_at = now;
  row.status = 'disabled';
  row.updated_at = now;
  await kvPutJson(db, gatewayKeyKey(id), row);
}

/**
 * Hard-delete a gateway key. Used for admin DELETE.
 */
export async function deleteGatewayKey(db: KVNamespace, id: string): Promise<void> {
  const row = await getGatewayKey(db, id);
  if (!row) return;
  await kvDelete(db, gatewayKeyKey(id));
  await kvDelete(db, gatewayKeyByHashKey(row.key_hash));
}
