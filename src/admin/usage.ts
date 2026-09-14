/**
 * Admin usage API handlers — reads the KV-backed analytics buckets
 * (`analytics:*`) and aggregates in memory (previously SQL over
 * `analytics_minutes`).
 */

import { Env } from '../env.ts';
import { getUsageRange } from '../db/usage.ts';
import { ANALYTICS_PREFIX } from '../kv/keys.ts';
import { kvDeletePrefix, kvListJson } from '../kv/store.ts';
import type { AnalyticsBucketRecord } from '../db/analytics.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseRange(url: URL): 'today' | '7d' | '30d' {
  const range = url.searchParams.get('range');
  if (range === 'today' || range === '7d' || range === '30d') return range;
  return 'today';
}

function usageRange(range: 'today' | '7d' | '30d', env: Env) {
  return getUsageRange(range, env.DEFAULT_TIMEZONE ?? 'Asia/Shanghai');
}

async function loadBucketsInRange(
  env: Env,
  start: number,
  end: number,
): Promise<AnalyticsBucketRecord[]> {
  const buckets = await kvListJson<AnalyticsBucketRecord>(env.DB, ANALYTICS_PREFIX);
  return buckets.filter((row) => {
    const minute = Number(row.timestamp_minute);
    return Number.isFinite(minute) && minute >= start && minute < end;
  });
}

/**
 * GET /admin/api/usage/overview?range=today|7d|30d
 */
export async function handleUsageOverview(
  url: URL,
  env: Env,
  requestId: string,
): Promise<Response> {
  const range = parseRange(url);
  const { start, end } = usageRange(range, env);
  const buckets = await loadBucketsInRange(env, start, end);

  const overview = {
    requests: 0, successes: 0, errors: 0, cancelled: 0, fallbacks: 0,
    input_tokens: 0, cache_input_tokens: 0, output_tokens: 0,
    usage_unknown: 0, cost_micros: 0,
  };
  for (const row of buckets) {
    overview.requests += Number(row.request_count ?? 0);
    overview.successes += Number(row.success_count ?? 0);
    overview.errors += Number(row.error_count ?? 0);
    overview.cancelled += Number(row.cancelled_count ?? 0);
    overview.fallbacks += Number(row.fallback_count ?? 0);
    overview.input_tokens += Number(row.input_tokens ?? 0);
    overview.cache_input_tokens += Number(row.cache_input_tokens ?? 0);
    overview.output_tokens += Number(row.output_tokens ?? 0);
    overview.usage_unknown += Number(row.usage_unknown_count ?? 0);
    overview.cost_micros += Number(row.cost_micros ?? 0);
  }
  return json({ range, ...overview });
}

/**
 * GET /admin/api/usage/by-model?range=...
 */
export async function handleUsageByModel(
  url: URL,
  env: Env,
  requestId: string,
): Promise<Response> {
  const range = parseRange(url);
  const { start, end } = usageRange(range, env);
  const buckets = await loadBucketsInRange(env, start, end);

  const byModel = new Map<string, {
    model_card_id: string;
    unified_model_id: string;
    requests: number; successes: number; errors: number;
    input_tokens: number; cache_input_tokens: number; output_tokens: number; cost_micros: number;
  }>();
  for (const row of buckets) {
    const key = `${row.model_card_id}\u0000${row.unified_model_id_snapshot}`;
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        model_card_id: row.model_card_id,
        unified_model_id: row.unified_model_id_snapshot,
        requests: 0, successes: 0, errors: 0,
        input_tokens: 0, cache_input_tokens: 0, output_tokens: 0, cost_micros: 0,
      };
      byModel.set(key, entry);
    }
    entry.requests += Number(row.request_count ?? 0);
    entry.successes += Number(row.success_count ?? 0);
    entry.errors += Number(row.error_count ?? 0);
    entry.input_tokens += Number(row.input_tokens ?? 0);
    entry.cache_input_tokens += Number(row.cache_input_tokens ?? 0);
    entry.output_tokens += Number(row.output_tokens ?? 0);
    entry.cost_micros += Number(row.cost_micros ?? 0);
  }

  return json({ range, models: [...byModel.values()] });
}

/**
 * GET /admin/api/usage/by-channel?range=...
 */
export async function handleUsageByChannel(
  url: URL,
  env: Env,
  requestId: string,
): Promise<Response> {
  const range = parseRange(url);
  const { start, end } = usageRange(range, env);
  const buckets = await loadBucketsInRange(env, start, end);

  const byChannel = new Map<string, {
    channel_id: string;
    channel_name: string;
    requests: number; successes: number; errors: number;
    input_tokens: number; output_tokens: number; cost_micros: number;
  }>();
  for (const row of buckets) {
    const key = `${row.channel_id}\u0000${row.channel_name_snapshot}`;
    let entry = byChannel.get(key);
    if (!entry) {
      entry = {
        channel_id: row.channel_id,
        channel_name: row.channel_name_snapshot,
        requests: 0, successes: 0, errors: 0,
        input_tokens: 0, output_tokens: 0, cost_micros: 0,
      };
      byChannel.set(key, entry);
    }
    entry.requests += Number(row.request_count ?? 0);
    entry.successes += Number(row.success_count ?? 0);
    entry.errors += Number(row.error_count ?? 0);
    entry.input_tokens += Number(row.input_tokens ?? 0);
    entry.output_tokens += Number(row.output_tokens ?? 0);
    entry.cost_micros += Number(row.cost_micros ?? 0);
  }

  return json({ range, channels: [...byChannel.values()] });
}

/**
 * DELETE /admin/api/usage — clears the current analytics aggregate.
 */
export async function handleUsageClear(
  env: Env,
  requestId: string,
): Promise<Response> {
  await kvDeletePrefix(env.DB, ANALYTICS_PREFIX);
  return json({ ok: true });
}
