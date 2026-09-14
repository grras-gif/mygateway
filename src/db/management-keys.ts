import { managementAuditKey, managementKeyByHashKey, managementKeyKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';

export type ManagementPermission = 'read' | 'write';
export const PERMANENT_MANAGEMENT_KEY_EXPIRY = 253_402_300_799;

export interface ManagementKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  permission: ManagementPermission;
  status: 'active' | 'disabled';
  expires_at: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export interface ManagementKeyPublic extends Omit<ManagementKeyRow, 'key_hash' | 'expires_at' | 'revoked_at'> {
  expires_at: number | null;
}

export function toPublicManagementKey(row: ManagementKeyRow): ManagementKeyPublic {
  const { key_hash: _hash, expires_at: expiresAt, revoked_at: _revokedAt, ...safe } = row;
  return {
    ...safe,
    expires_at: expiresAt >= PERMANENT_MANAGEMENT_KEY_EXPIRY ? null : expiresAt,
  };
}

export async function listManagementKeys(db: KVNamespace): Promise<ManagementKeyRow[]> {
  const rows = await kvListJson<ManagementKeyRow>(db, KEY_PREFIX.managementKey);
  return rows.sort((a, b) => b.created_at - a.created_at);
}

export async function getManagementKey(db: KVNamespace, id: string): Promise<ManagementKeyRow | null> {
  return kvGetJson<ManagementKeyRow>(db, managementKeyKey(id));
}

export async function createManagementKey(db: KVNamespace, key: {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  permission: ManagementPermission;
  expiresAt: number;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row: ManagementKeyRow = {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    key_hash: key.keyHash,
    permission: key.permission,
    status: 'active',
    expires_at: key.expiresAt,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    revoked_at: null,
  };
  await kvPutJson(db, managementKeyKey(key.id), row);
  await db.put(managementKeyByHashKey(key.keyHash), key.id);
}

export async function findActiveManagementKeyByHash(
  db: KVNamespace,
  keyHash: string,
): Promise<ManagementKeyRow | null> {
  const id = await db.get(managementKeyByHashKey(keyHash));
  if (!id) return null;
  const row = await getManagementKey(db, id);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.status !== 'active' || row.revoked_at !== null || row.expires_at <= now) return null;
  return row;
}

export async function updateManagementKey(db: KVNamespace, id: string, update: {
  name?: string;
  permission?: ManagementPermission;
  status?: 'active' | 'disabled';
  expiresAt?: number;
}): Promise<void> {
  const row = await getManagementKey(db, id);
  if (!row) return;
  if (update.name !== undefined) row.name = update.name;
  if (update.permission !== undefined) row.permission = update.permission;
  if (update.status !== undefined) row.status = update.status;
  if (update.expiresAt !== undefined) row.expires_at = update.expiresAt;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, managementKeyKey(id), row);
}

export async function deleteManagementKey(db: KVNamespace, id: string): Promise<void> {
  const row = await getManagementKey(db, id);
  if (row) await kvDelete(db, managementKeyByHashKey(row.key_hash));
  await kvDelete(db, managementKeyKey(id));
}

export async function recordManagementAudit(db: KVNamespace, entry: {
  id: string;
  keyId: string;
  method: string;
  path: string;
  status: number;
  requestId: string;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await kvPutJson(db, managementAuditKey(entry.id), {
    id: entry.id,
    management_key_id: entry.keyId,
    method: entry.method,
    path: entry.path,
    status: entry.status,
    request_id: entry.requestId,
    created_at: now,
  });

  const key = await getManagementKey(db, entry.keyId);
  if (key && (key.last_used_at === null || key.last_used_at < now - 300)) {
    key.last_used_at = now;
    await kvPutJson(db, managementKeyKey(entry.keyId), key);
  }
}

export async function cleanupManagementAudit(db: KVNamespace, retentionDays: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86_400;
  const rows = await kvListJson<{ id: string; created_at: number }>(db, KEY_PREFIX.managementAudit);
  const expired = rows.filter((row) => row.created_at < cutoff);
  await Promise.all(expired.map((row) => kvDelete(db, managementAuditKey(row.id))));
  return expired.length;
}
