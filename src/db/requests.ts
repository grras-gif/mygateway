/**
 * Per-key daily usage aggregation and recent request spend logs (KV-backed).
 *
 * Each `(key_id, date)` authority row is a single KV entry so the period
 * budget check is a bounded prefix list instead of a SQL range scan.
 */

import { keyUsageKey, keyUsagePrefix, parseKeyUsageKey, requestLogKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvListKeys, kvPutJson } from '../kv/store.ts';

export interface KeyDailyUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

interface StoredKeyUsage {
  key_id: string;
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

export function utcDateString(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function toUsage(row: StoredKeyUsage | null): KeyDailyUsage {
  return {
    requests: Number(row?.requests ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    costMicros: Number(row?.cost_micros ?? 0),
  };
}

export async function readKeyDailyUsage(
  db: KVNamespace,
  keyId: string,
  date: string,
): Promise<KeyDailyUsage> {
  const row = await kvGetJson<StoredKeyUsage>(db, keyUsageKey(keyId, date));
  return toUsage(row);
}

/**
 * Sum the daily authority rows for one half-open UTC calendar window.
 * The `key_usage:<keyId>:` prefix makes this a bounded list.
 */
export async function readKeyPeriodUsage(
  db: KVNamespace,
  keyId: string,
  startDate: string,
  endDate: string,
): Promise<KeyDailyUsage> {
  const rows = await kvListJson<StoredKeyUsage>(db, keyUsagePrefix(keyId));
  const total: KeyDailyUsage = { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };
  for (const row of rows) {
    if (row.date < startDate || row.date >= endDate) continue;
    total.requests += Number(row.requests ?? 0);
    total.inputTokens += Number(row.input_tokens ?? 0);
    total.outputTokens += Number(row.output_tokens ?? 0);
    total.costMicros += Number(row.cost_micros ?? 0);
  }
  return total;
}

export async function upsertKeyDailyUsage(
  db: KVNamespace,
  keyId: string,
  date: string,
  delta: { requests: number; inputTokens: number; outputTokens: number; costMicros: number },
): Promise<void> {
  const key = keyUsageKey(keyId, date);
  const existing = await kvGetJson<StoredKeyUsage>(db, key);
  const next: StoredKeyUsage = {
    key_id: keyId,
    date,
    requests: Number(existing?.requests ?? 0) + delta.requests,
    input_tokens: Number(existing?.input_tokens ?? 0) + delta.inputTokens,
    output_tokens: Number(existing?.output_tokens ?? 0) + delta.outputTokens,
    cost_micros: Number(existing?.cost_micros ?? 0) + delta.costMicros,
  };
  await kvPutJson(db, key, next);
}

export type RequestLogStatus =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'not_allowed'
  | 'expired';

/** Request-log records are stored under `request_log:<id>`. */
export interface RequestLogRecord extends Record<string, unknown> {
  id: string;
  timestamp: number;
  request_id: string | null;
  key_id: string | null;
  key_name: string | null;
  model_card_id: string | null;
  unified_model_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  status: RequestLogStatus;
  stream: 0 | 1;
  cached: 0 | 1;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  attempt_count: number;
  fallback: 0 | 1;
  latency_ms: number;
  ttft_ms: number | null;
  requested_protocol: string | null;
  error_detail: string | null;
  context_request_iv?: string | null;
  context_request_tag?: string | null;
  context_request_ciphertext?: string | null;
  context_response_iv?: string | null;
  context_response_tag?: string | null;
  context_response_ciphertext?: string | null;
}

export async function putRequestLog(db: KVNamespace, record: RequestLogRecord): Promise<void> {
  await kvPutJson(db, requestLogKey(record.id), record);
}

export async function cleanupRequestLogs(
  db: KVNamespace,
  retentionDays: number,
): Promise<number> {
  const cutoff = Math.floor((Date.now() - retentionDays * 86_400_000) / 1000);
  const rows = await kvListJson<RequestLogRecord>(db, KEY_PREFIX.requestLog);
  const expired = rows.filter((row) => Number(row.timestamp) < cutoff);
  await Promise.all(expired.map((row) => kvDelete(db, requestLogKey(row.id))));
  return expired.length;
}

export async function cleanupKeyDailyUsage(db: KVNamespace, retentionDays: number): Promise<number> {
  const cutoff = utcDateString(Date.now() - retentionDays * 86_400_000);
  const keys = await kvListKeys(db, KEY_PREFIX.keyUsage);
  let removed = 0;
  for (const key of keys) {
    const parsed = parseKeyUsageKey(key);
    if (parsed && parsed.date < cutoff) {
      await kvDelete(db, key);
      removed++;
    }
  }
  return removed;
}
