import { generateId } from '../shared/ids.ts';
import { PasswordDigest } from '../auth/password.ts';
import { adminUserKey, adminUserByNameKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListKeys, kvPutJson } from '../kv/store.ts';

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  must_change_password: 0 | 1;
  session_version: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export async function getAdminByUsername(db: KVNamespace, username: string): Promise<AdminUserRow | null> {
  const id = await db.get(adminUserByNameKey(username));
  if (!id) return null;
  return getAdminById(db, id);
}

export async function getAdminById(db: KVNamespace, id: string): Promise<AdminUserRow | null> {
  return kvGetJson<AdminUserRow>(db, adminUserKey(id));
}

export async function hasAdminUser(db: KVNamespace): Promise<boolean> {
  const keys = await kvListKeys(db, KEY_PREFIX.adminUser);
  return keys.length > 0;
}

export async function createInitialAdmin(
  db: KVNamespace,
  username: string,
  digest: PasswordDigest,
): Promise<AdminUserRow> {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  const row: AdminUserRow = {
    id,
    username,
    password_hash: digest.hash,
    password_salt: digest.salt,
    password_iterations: digest.iterations,
    must_change_password: 1,
    session_version: 1,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  await kvPutJson(db, adminUserKey(id), row);
  await db.put(adminUserByNameKey(username), id);
  return row;
}

export async function recordAdminLogin(db: KVNamespace, id: string): Promise<void> {
  const row = await getAdminById(db, id);
  if (!row) return;
  row.last_login_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, adminUserKey(id), row);
}

export async function updateAdminCredentials(
  db: KVNamespace,
  id: string,
  username: string,
  digest: PasswordDigest,
): Promise<AdminUserRow> {
  const row = await getAdminById(db, id);
  if (!row) throw new Error('Admin user not found');
  const previousUsername = row.username;
  row.username = username;
  row.password_hash = digest.hash;
  row.password_salt = digest.salt;
  row.password_iterations = digest.iterations;
  row.must_change_password = 0;
  row.session_version += 1;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, adminUserKey(id), row);
  if (previousUsername !== username) {
    await kvDelete(db, adminUserByNameKey(previousUsername));
    await db.put(adminUserByNameKey(username), id);
  }
  return row;
}
