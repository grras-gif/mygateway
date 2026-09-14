/**
 * Analytics data operations (KV-backed) — 5-minute aggregation buckets and
 * cursor-paginated request_logs queries.
 *
 * Analytics buckets are stored under `analytics:<padded-minute>:<card>:<channel>:<key>`
 * so a prefix list yields time-ordered buckets. SQL GROUP BY / SUM are computed
 * in memory over the selected window.
 */

import { ANALYTICS_PREFIX, analyticsKey, KEY_PREFIX, requestLogKey } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';
import { getSetting } from './settings.ts';
import type { RequestLogRecord, RequestLogStatus } from './requests.ts';

// ---- Analytics 5-min bucket ----

/** Round a Unix timestamp (seconds) down to the nearest 5-minute boundary. */
export function fiveMinuteFloor(ts: number): number {
  return Math.floor(ts / 300) * 300;
}

export interface AnalyticsDelta {
  request_count: number;
  success_count: number;
  error_count: number;
  cancelled_count: number;
  fallback_count: number;
  attempt_count_total: number;
  input_tokens: number;
  cache_input_tokens: number;
  output_tokens: number;
  usage_unknown_count: number;
  cost_micros: number;
  latency_ms_sum: number;
  latency_ms_count: number;
  ttft_ms_sum: number;
  ttft_ms_count: number;
}

/** Stored analytics bucket: snapshots plus the additive counters. */
export interface AnalyticsBucketRecord extends AnalyticsDelta {
  timestamp_minute: number;
  model_card_id: string;
  channel_id: string;
  unified_model_id_snapshot: string;
  channel_name_snapshot: string;
  key_id: string;
}

export async function upsertAnalyticsMinute(
  db: KVNamespace,
  bucket: {
    timestamp_minute: number;
    model_card_id: string;
    channel_id: string;
    unified_model_id: string;
    channel_name: string;
    key_id: string;
  },
  delta: AnalyticsDelta,
): Promise<void> {
  const key = analyticsKey(
    bucket.timestamp_minute,
    bucket.model_card_id,
    bucket.channel_id,
    bucket.key_id,
  );
  const existing = await kvGetJson<AnalyticsBucketRecord>(db, key);
  const next: AnalyticsBucketRecord = {
    timestamp_minute: bucket.timestamp_minute,
    model_card_id: bucket.model_card_id,
    channel_id: bucket.channel_id,
    unified_model_id_snapshot: bucket.unified_model_id || existing?.unified_model_id_snapshot || '',
    channel_name_snapshot: bucket.channel_name || existing?.channel_name_snapshot || '',
    key_id: bucket.key_id,
    request_count: (existing?.request_count ?? 0) + delta.request_count,
    success_count: (existing?.success_count ?? 0) + delta.success_count,
    error_count: (existing?.error_count ?? 0) + delta.error_count,
    cancelled_count: (existing?.cancelled_count ?? 0) + delta.cancelled_count,
    fallback_count: (existing?.fallback_count ?? 0) + delta.fallback_count,
    attempt_count_total: (existing?.attempt_count_total ?? 0) + delta.attempt_count_total,
    input_tokens: (existing?.input_tokens ?? 0) + delta.input_tokens,
    cache_input_tokens: (existing?.cache_input_tokens ?? 0) + delta.cache_input_tokens,
    output_tokens: (existing?.output_tokens ?? 0) + delta.output_tokens,
    usage_unknown_count: (existing?.usage_unknown_count ?? 0) + delta.usage_unknown_count,
    cost_micros: (existing?.cost_micros ?? 0) + delta.cost_micros,
    latency_ms_sum: (existing?.latency_ms_sum ?? 0) + delta.latency_ms_sum,
    latency_ms_count: (existing?.latency_ms_count ?? 0) + delta.latency_ms_count,
    ttft_ms_sum: (existing?.ttft_ms_sum ?? 0) + delta.ttft_ms_sum,
    ttft_ms_count: (existing?.ttft_ms_count ?? 0) + delta.ttft_ms_count,
  };
  await kvPutJson(db, key, next);
}

// ---- Analytics Usage Query ----

export interface AnalyticsUsageSummary {
  requests: number;
  successes: number;
  errors: number;
  cancelled: number;
  fallbacks: number;
  input_tokens: number;
  cache_input_tokens: number;
  output_tokens: number;
  usage_unknown: number;
  cost_micros: number;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
  ttft_count: number;
  latency_count: number;
}

export interface AnalyticsModelRow extends AnalyticsUsageSummary {
  model_card_id: string;
  unified_model_id: string;
}

export interface AnalyticsTrendPoint {
  bucket: number; // Unix seconds (5-min floor)
  requests: number;
  input_tokens: number;
  cache_input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

interface Aggregate {
  requests: number;
  successes: number;
  errors: number;
  cancelled: number;
  fallbacks: number;
  input_tokens: number;
  cache_input_tokens: number;
  output_tokens: number;
  usage_unknown: number;
  cost_micros: number;
  latency_ms_sum: number;
  latency_ms_count: number;
  ttft_ms_sum: number;
  ttft_ms_count: number;
}

function emptyAggregate(): Aggregate {
  return {
    requests: 0, successes: 0, errors: 0, cancelled: 0, fallbacks: 0,
    input_tokens: 0, cache_input_tokens: 0, output_tokens: 0, usage_unknown: 0,
    cost_micros: 0, latency_ms_sum: 0, latency_ms_count: 0, ttft_ms_sum: 0, ttft_ms_count: 0,
  };
}

function addBucket(agg: Aggregate, row: AnalyticsBucketRecord): void {
  agg.requests += Number(row.request_count ?? 0);
  agg.successes += Number(row.success_count ?? 0);
  agg.errors += Number(row.error_count ?? 0);
  agg.cancelled += Number(row.cancelled_count ?? 0);
  agg.fallbacks += Number(row.fallback_count ?? 0);
  agg.input_tokens += Number(row.input_tokens ?? 0);
  agg.cache_input_tokens += Number(row.cache_input_tokens ?? 0);
  agg.output_tokens += Number(row.output_tokens ?? 0);
  agg.usage_unknown += Number(row.usage_unknown_count ?? 0);
  agg.cost_micros += Number(row.cost_micros ?? 0);
  agg.latency_ms_sum += Number(row.latency_ms_sum ?? 0);
  agg.latency_ms_count += Number(row.latency_ms_count ?? 0);
  agg.ttft_ms_sum += Number(row.ttft_ms_sum ?? 0);
  agg.ttft_ms_count += Number(row.ttft_ms_count ?? 0);
}

function toSummary(agg: Aggregate): AnalyticsUsageSummary {
  return {
    requests: agg.requests,
    successes: agg.successes,
    errors: agg.errors,
    cancelled: agg.cancelled,
    fallbacks: agg.fallbacks,
    input_tokens: agg.input_tokens,
    cache_input_tokens: agg.cache_input_tokens,
    output_tokens: agg.output_tokens,
    usage_unknown: agg.usage_unknown,
    cost_micros: agg.cost_micros,
    avg_latency_ms: agg.latency_ms_count > 0 ? Math.round(agg.latency_ms_sum / agg.latency_ms_count) : null,
    avg_ttft_ms: agg.ttft_ms_count > 0 ? Math.round(agg.ttft_ms_sum / agg.ttft_ms_count) : null,
    ttft_count: agg.ttft_ms_count,
    latency_count: agg.latency_ms_count,
  };
}

export async function queryAnalyticsUsage(
  db: KVNamespace,
  params: {
    start: number;
    end: number;
    modelId?: string;
    keyId?: string;
    granularity?: 'hour' | 'day';
  },
): Promise<{
  summary: AnalyticsUsageSummary;
  models: AnalyticsModelRow[];
  trends: AnalyticsTrendPoint[];
}> {
  const buckets = await kvListJson<AnalyticsBucketRecord>(db, ANALYTICS_PREFIX);

  const summaryAgg = emptyAggregate();
  const modelAgg = new Map<string, { row: Aggregate; model_card_id: string; unified_model_id: string }>();
  const trendAgg = new Map<number, AnalyticsTrendPoint>();

  const bucketExpr = (minute: number): number =>
    params.granularity === 'hour'
      ? Math.floor(minute / 3600) * 3600
      : params.granularity === 'day'
        ? Math.floor(minute / 86400) * 86400
        : minute;

  for (const row of buckets) {
    const minute = Number(row.timestamp_minute);
    if (!Number.isFinite(minute) || minute < params.start || minute >= params.end) continue;
    if (params.modelId && row.unified_model_id_snapshot !== params.modelId) continue;
    if (params.keyId && row.key_id !== params.keyId) continue;

    addBucket(summaryAgg, row);

    const modelKey = `${row.model_card_id}\u0000${row.unified_model_id_snapshot}`;
    let modelEntry = modelAgg.get(modelKey);
    if (!modelEntry) {
      modelEntry = {
        row: emptyAggregate(),
        model_card_id: row.model_card_id,
        unified_model_id: row.unified_model_id_snapshot,
      };
      modelAgg.set(modelKey, modelEntry);
    }
    addBucket(modelEntry.row, row);

    const bucket = bucketExpr(minute);
    let trend = trendAgg.get(bucket);
    if (!trend) {
      trend = { bucket, requests: 0, input_tokens: 0, cache_input_tokens: 0, output_tokens: 0, cost_micros: 0 };
      trendAgg.set(bucket, trend);
    }
    trend.requests += Number(row.request_count ?? 0);
    trend.input_tokens += Number(row.input_tokens ?? 0);
    trend.cache_input_tokens += Number(row.cache_input_tokens ?? 0);
    trend.output_tokens += Number(row.output_tokens ?? 0);
    trend.cost_micros += Number(row.cost_micros ?? 0);
  }

  const models: AnalyticsModelRow[] = [...modelAgg.values()]
    .map((entry) => ({
      ...toSummary(entry.row),
      model_card_id: entry.model_card_id,
      unified_model_id: entry.unified_model_id,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 100);

  const trendLimit = params.granularity === 'day' ? 90 : params.granularity === 'hour' ? 744 : 9000;
  const trends = [...trendAgg.values()]
    .sort((a, b) => a.bucket - b.bucket)
    .slice(0, trendLimit);

  return { summary: toSummary(summaryAgg), models, trends };
}

// ---- Cursor-paginated log queries ----

export interface LogQueryParams {
  limit: number;
  cursor?: { timestamp: number; id: string };
  startTime?: number;
  endTime?: number;
  modelId?: string;
  keyId?: string;
  channelId?: string;
  status?: RequestLogStatus | 'all';
  requestId?: string;
}

export interface LogQueryResult {
  rows: Array<Record<string, unknown>>;
  nextCursor: { timestamp: number; id: string } | null;
}

export async function queryLogsCursor(
  db: KVNamespace,
  params: LogQueryParams,
): Promise<LogQueryResult> {
  const limit = Math.min(Math.max(params.limit, 1), 100);
  const records = await kvListJson<RequestLogRecord>(db, KEY_PREFIX.requestLog);

  const matches = records
    .filter((row) => {
      const timestamp = Number(row.timestamp);
      if (params.startTime !== undefined && timestamp < params.startTime) return false;
      if (params.endTime !== undefined && timestamp > params.endTime) return false;
      if (params.modelId && row.unified_model_id !== params.modelId) return false;
      if (params.keyId && row.key_id !== params.keyId) return false;
      if (params.channelId && row.channel_id !== params.channelId) return false;
      if (params.status && params.status !== 'all' && row.status !== params.status) return false;
      if (params.requestId && row.request_id !== params.requestId) return false;
      if (params.cursor) {
        const t = Number(row.timestamp);
        if (t > params.cursor.timestamp) return false;
        if (t === params.cursor.timestamp && String(row.id) >= params.cursor.id) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ta = Number(a.timestamp);
      const tb = Number(b.timestamp);
      if (ta !== tb) return tb - ta;
      return String(b.id).localeCompare(String(a.id));
    });

  const rows = matches.slice(0, limit) as Array<Record<string, unknown>>;
  const hasMore = matches.length > limit;
  const nextCursor = hasMore && rows.length > 0
    ? { timestamp: rows[rows.length - 1].timestamp as number, id: rows[rows.length - 1].id as string }
    : null;

  return { rows, nextCursor };
}

export async function getLogById(
  db: KVNamespace,
  id: string,
): Promise<Record<string, unknown> | null> {
  const row = await kvGetJson<RequestLogRecord>(db, requestLogKey(id));
  return row ?? null;
}

export async function clearAllLogs(db: KVNamespace): Promise<number> {
  const records = await kvListJson<RequestLogRecord>(db, KEY_PREFIX.requestLog);
  await Promise.all(records.map((row) => kvDelete(db, requestLogKey(row.id))));
  return records.length;
}

export async function cleanupAnalytics(
  db: KVNamespace,
  retentionDays: number,
): Promise<number> {
  const cutoff = Math.floor((Date.now() - retentionDays * 86_400_000) / 300_000) * 300;
  const buckets = await kvListJson<AnalyticsBucketRecord>(db, ANALYTICS_PREFIX);
  const expired = buckets.filter((row) => Number(row.timestamp_minute) < cutoff);
  await Promise.all(
    expired.map((row) =>
      kvDelete(db, analyticsKey(row.timestamp_minute, row.model_card_id, row.channel_id, row.key_id)),
    ),
  );
  return expired.length;
}

/** Nullify context columns older than retentionHours to enforce privacy window. */
export async function cleanupContext(
  db: KVNamespace,
  retentionHours: number,
): Promise<number> {
  const cutoff = Math.floor((Date.now() - retentionHours * 3_600_000) / 1000);
  const records = await kvListJson<RequestLogRecord>(db, KEY_PREFIX.requestLog);
  let updated = 0;
  for (const row of records) {
    if (Number(row.timestamp) >= cutoff) continue;
    const hasContext = row.context_request_ciphertext || row.context_response_ciphertext;
    if (!hasContext) continue;
    const next: RequestLogRecord = {
      ...row,
      context_request_iv: null,
      context_request_tag: null,
      context_request_ciphertext: null,
      context_response_iv: null,
      context_response_tag: null,
      context_response_ciphertext: null,
    };
    await kvPutJson(db, requestLogKey(row.id), next);
    updated++;
  }
  return updated;
}

/** Read analytics settings from KV settings in a bounded set of gets. */
export async function readAnalyticsSettings(db: KVNamespace): Promise<{
  requestLogsEnabled: boolean;
  logSuccess: boolean;
  logErrors: boolean;
  logContext: boolean;
  contextRetentionHours: number;
  requestLogRetentionDays: number;
}> {
  const keys = ['request_logs_enabled', 'log_success', 'log_errors', 'log_context', 'context_retention_hours', 'request_log_retention_days'];
  const values = await Promise.all(keys.map((key) => getSetting(db, key)));

  const getBool = (index: number, defaultVal: boolean) => {
    const v = values[index];
    if (v === null || v === undefined) return defaultVal;
    return v !== 'false';
  };

  return {
    requestLogsEnabled: getBool(0, true),
    logSuccess: getBool(1, true),
    logErrors: getBool(2, true),
    logContext: getBool(3, false),
    contextRetentionHours: parseInt(values[4] ?? '24', 10) || 24,
    requestLogRetentionDays: parseInt(values[5] ?? '7', 10) || 7,
  };
}
