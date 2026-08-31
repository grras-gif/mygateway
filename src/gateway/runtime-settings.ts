/** Runtime settings that can be changed from the admin console. */

import { TtlLruCache } from '../cache/ttl-lru.ts';
import { getSetting } from '../db/settings.ts';

export const MEBIBYTE = 1_048_576;
export const DEFAULT_MAX_REQUEST_BODY_MIB = 16;
export const MAX_REQUEST_BODY_MIB = 64;
export const MAX_REQUEST_BODY_SETTING = 'max_request_body_bytes';

const SETTINGS_TTL_MS = 60_000;
const settingCache = new TtlLruCache<string, number>(4);

export function parseMaxRequestBodyMiB(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)
    || parsed < DEFAULT_MAX_REQUEST_BODY_MIB
    || parsed > MAX_REQUEST_BODY_MIB) {
    throw new Error(
      `max_request_body_mib must be an integer between ${DEFAULT_MAX_REQUEST_BODY_MIB} and ${MAX_REQUEST_BODY_MIB}`,
    );
  }
  return parsed;
}

export async function readMaxRequestBytes(
  db: D1Database,
  deploymentFallbackBytes = DEFAULT_MAX_REQUEST_BODY_MIB * MEBIBYTE,
): Promise<number> {
  const cached = settingCache.get(MAX_REQUEST_BODY_SETTING);
  if (cached !== undefined) return cached;

  const raw = await getSetting(db, MAX_REQUEST_BODY_SETTING);
  const stored = raw === null ? Number.NaN : Number(raw);
  const safeDeploymentFallback = Number.isInteger(deploymentFallbackBytes)
    && deploymentFallbackBytes % MEBIBYTE === 0
    && deploymentFallbackBytes >= DEFAULT_MAX_REQUEST_BODY_MIB * MEBIBYTE
    && deploymentFallbackBytes <= MAX_REQUEST_BODY_MIB * MEBIBYTE
    ? deploymentFallbackBytes
    : DEFAULT_MAX_REQUEST_BODY_MIB * MEBIBYTE;
  const value = Number.isInteger(stored)
    && stored % MEBIBYTE === 0
    && stored >= DEFAULT_MAX_REQUEST_BODY_MIB * MEBIBYTE
    && stored <= MAX_REQUEST_BODY_MIB * MEBIBYTE
    ? stored
    : safeDeploymentFallback;
  settingCache.set(MAX_REQUEST_BODY_SETTING, value, SETTINGS_TTL_MS);
  return value;
}

export function invalidateRuntimeSettingsCache(): void {
  settingCache.clear();
}

/** Test-only reset. */
export function resetRuntimeSettingsCache(): void {
  settingCache.clear();
}
