/**
 * KV key prefixes and key builders.
 *
 * KV is schema-less, so every entity type owns a fixed prefix and every unique
 * lookup uses a secondary index key that stores only an id. This module is the
 * single source of truth for key construction; domain modules must not build
 * prefixes inline.
 */

export const KEY_PREFIX = {
  setting: 'setting:',
  adminUser: 'admin_user:',
  adminUserName: 'admin_user_name:',
  channel: 'channel:',
  channelProtocol: 'channel_protocol:',
  providerModel: 'provider_model:',
  discovery: 'discovery:',
  modelCard: 'model_card:',
  channelModel: 'channel_model:',
  modelIdentifier: 'model_identifier:',
  gatewayKey: 'gateway_key:',
  gatewayKeyHash: 'gateway_key_hash:',
  managementKey: 'management_key:',
  managementKeyHash: 'management_key_hash:',
  managementAudit: 'management_audit:',
  keyUsage: 'key_usage:',
  requestLog: 'request_log:',
  modelPrice: 'model_price:',
  bootstrap: 'bootstrap:',
} as const;

/** Analytics buckets are time-ordered; the prefix is listed for range scans. */
export const ANALYTICS_PREFIX = 'analytics:';

/** `setting:<key>` — a small set of control-plane flags and runtime settings. */
export function settingKey(key: string): string {
  return `${KEY_PREFIX.setting}${key}`;
}

/** `admin_user:<id>` — the single administrator record. */
export function adminUserKey(id: string): string {
  return `${KEY_PREFIX.adminUser}${id}`;
}

/** `admin_user_name:<username>` — unique username → admin id index. */
export function adminUserByNameKey(username: string): string {
  return `${KEY_PREFIX.adminUserName}${username}`;
}

/** `channel:<id>` — provider channel. */
export function channelKey(id: string): string {
  return `${KEY_PREFIX.channel}${id}`;
}

/** `channel_protocol:<channel_id>:` — native protocol endpoint prefix. */
export function channelProtocolPrefix(channelId: string): string {
  return `${KEY_PREFIX.channelProtocol}${channelId}:`;
}

/** `channel_protocol:<channel_id>:<protocol>` — one native endpoint. */
export function channelProtocolKey(channelId: string, protocol: string): string {
  return `${channelProtocolPrefix(channelId)}${protocol}`;
}

/** `provider_model:<channel_id>:` — per-channel inventory prefix. */
export function providerModelPrefix(channelId: string): string {
  return `${KEY_PREFIX.providerModel}${channelId}:`;
}

/** `provider_model:<channel_id>:<provider_model_id>` — one inventory row. */
export function providerModelKey(channelId: string, providerModelId: string): string {
  return `${providerModelPrefix(channelId)}${providerModelId}`;
}

/** `discovery:<channel_id>` — last discovery state for a channel. */
export function discoveryKey(channelId: string): string {
  return `${KEY_PREFIX.discovery}${channelId}`;
}

/** `model_card:<id>` — unified model card. */
export function modelCardKey(id: string): string {
  return `${KEY_PREFIX.modelCard}${id}`;
}

/** `channel_model:<id>` — channel model instance. */
export function channelModelKey(id: string): string {
  return `${KEY_PREFIX.channelModel}${id}`;
}

/** `model_identifier:<identifier>` — global unified-id / alias namespace. */
export function modelIdentifierKey(identifier: string): string {
  return `${KEY_PREFIX.modelIdentifier}${identifier}`;
}

/** `gateway_key:<id>` — Gateway Key entity. */
export function gatewayKeyKey(id: string): string {
  return `${KEY_PREFIX.gatewayKey}${id}`;
}

/** `gateway_key_hash:<hash>` — unique hash → Gateway Key id index. */
export function gatewayKeyByHashKey(hash: string): string {
  return `${KEY_PREFIX.gatewayKeyHash}${hash}`;
}

/** `management_key:<id>` — Management Key entity. */
export function managementKeyKey(id: string): string {
  return `${KEY_PREFIX.managementKey}${id}`;
}

/** `management_key_hash:<hash>` — unique hash → Management Key id index. */
export function managementKeyByHashKey(hash: string): string {
  return `${KEY_PREFIX.managementKeyHash}${hash}`;
}

/** `management_audit:<id>` — one Management API audit record. */
export function managementAuditKey(id: string): string {
  return `${KEY_PREFIX.managementAudit}${id}`;
}

/** `key_usage:<key_id>:<date>` — per-key UTC daily usage authority row. */
export function keyUsageKey(keyId: string, date: string): string {
  return `${KEY_PREFIX.keyUsage}${keyId}:${date}`;
}

/** `key_usage:<key_id>:` — bounded prefix for one key's period budget scan. */
export function keyUsagePrefix(keyId: string): string {
  return `${KEY_PREFIX.keyUsage}${keyId}:`;
}

/** Parse a `key_usage:<key_id>:<date>` key back into its parts. */
export function parseKeyUsageKey(key: string): { keyId: string; date: string } | null {
  if (!key.startsWith(KEY_PREFIX.keyUsage)) return null;
  const rest = key.slice(KEY_PREFIX.keyUsage.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return null;
  return { keyId: rest.slice(0, separator), date: rest.slice(separator + 1) };
}

/** `request_log:<id>` — optional request detail log. */
export function requestLogKey(id: string): string {
  return `${KEY_PREFIX.requestLog}${id}`;
}

/** `model_price:<provider_model_id>` — editable baseline price entry. */
export function modelPriceKey(providerModelId: string): string {
  return `${KEY_PREFIX.modelPrice}${providerModelId}`;
}

/** `bootstrap:<name>` — idempotent runtime seed markers. */
export function bootstrapKey(name: string): string {
  return `${KEY_PREFIX.bootstrap}${name}`;
}

/**
 * `analytics:<padded-minute>:<card>:<channel>:<key>` — 5-minute aggregate
 * bucket. The zero-padded minute keeps a prefix list time-ordered.
 */
export function analyticsKey(
  timestampMinute: number,
  modelCardId: string,
  channelId: string,
  keyId: string,
): string {
  const padded = String(Math.floor(timestampMinute)).padStart(12, '0');
  return `${ANALYTICS_PREFIX}${padded}:${modelCardId}:${channelId}:${keyId}`;
}
