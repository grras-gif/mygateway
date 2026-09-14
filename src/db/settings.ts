/**
 * Simple key/value settings storage (control-plane flags).
 * Backed by Blob storage (previously the system_settings table).
 */

import { settingKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvGetJson, kvListKeys, kvPutJson } from '../kv/store.ts';

interface SettingRecord {
  value: string;
  updated_at: number;
}

export async function getSetting(db: BlobStore, key: string): Promise<string | null> {
  const record = await kvGetJson<SettingRecord>(db, settingKey(key));
  return record?.value ?? null;
}

export async function setSetting(db: BlobStore, key: string, value: string): Promise<void> {
  await kvPutJson(db, settingKey(key), {
    value,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

/** List every stored setting as `{ key, value, updated_at }`. */
export async function listSettings(
  db: BlobStore,
): Promise<Array<{ key: string; value: string; updated_at: number }>> {
  const keys = await kvListKeys(db, KEY_PREFIX.setting);
  const result: Array<{ key: string; value: string; updated_at: number }> = [];
  for (const fullKey of keys) {
    const record = await kvGetJson<SettingRecord>(db, fullKey);
    if (!record) continue;
    result.push({
      key: fullKey.slice(KEY_PREFIX.setting.length),
      value: record.value,
      updated_at: record.updated_at,
    });
  }
  return result;
}
