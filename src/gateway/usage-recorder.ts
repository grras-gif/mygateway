/**
 * Request accounting: aggregate analytics, per-key daily usage, and optional
 * request log are written to KV inside waitUntil so the upstream response is
 * never blocked.
 *
 * Analytics (5-min buckets) and key_daily_usage are always recorded.
 * request_logs is gated by the master switch and level policy.
 * Context is encrypted only when log_context is explicitly enabled.
 */

import { Env } from '../env.ts';
import { generateId } from '../shared/ids.ts';
import { computeCostMicros } from '../shared/cost.ts';
import { utcDateString, putRequestLog, type RequestLogRecord, type RequestLogStatus } from '../db/requests.ts';
import { fiveMinuteFloor, upsertAnalyticsMinute, type AnalyticsDelta } from '../db/analytics.ts';
import { upsertKeyDailyUsage } from '../db/requests.ts';
import { bumpKeyQuotaLedger } from './key-quota.ts';
import { deriveContextKey, encryptContext, type EncryptedContext } from '../crypto/context-encrypt.ts';
import type { LogPolicy } from './log-policy.ts';
import type { Usage } from '../streaming/sse-decoder.ts';

export interface UsageRecordContext {
  modelCardId: string;
  unifiedModelId: string;
  channelId: string;
  channelName: string;
  inputPriceMicrosPerMillion: number | null;
  outputPriceMicrosPerMillion: number | null;
  cacheInputPriceMicrosPerMillion: number | null;
  attemptCount: number;
  fallbackOccurred: boolean;
  stream: boolean;
  cached: boolean;
  keyId: string;
  keyName: string;
  requestId: string;
  /** Request-log level policy (only gates the detail log, never usage/budget). */
  policy: LogPolicy;
  /** Client-requested protocol (openai_chat / openai_responses / anthropic_messages). */
  requestedProtocol?: string;
  /** TTFT in ms — only recorded for streaming requests with valid first output. */
  ttftMs?: number;
  /** Request context preview (max 4 KiB) — encrypted only if logContext is on. */
  contextRequest?: string;
  /** Response context preview (max 4 KiB) — encrypted only if logContext is on. */
  contextResponse?: string;
}

export type RecordOutcome = 'success' | 'error' | 'cancelled';

function outcomeStatus(outcome: RecordOutcome): RequestLogStatus {
  if (outcome === 'success') return 'success';
  return outcome === 'error' ? 'error' : 'cancelled';
}

function emptyDelta(): AnalyticsDelta {
  return {
    request_count: 0,
    success_count: 0,
    error_count: 0,
    cancelled_count: 0,
    fallback_count: 0,
    attempt_count_total: 0,
    input_tokens: 0,
    cache_input_tokens: 0,
    output_tokens: 0,
    usage_unknown_count: 0,
    cost_micros: 0,
    latency_ms_sum: 0,
    latency_ms_count: 0,
    ttft_ms_sum: 0,
    ttft_ms_count: 0,
  };
}

/** Write analytics + key usage + optional log to KV. */
export async function recordRequestCompletion(
  env: Env,
  ctx: UsageRecordContext,
  outcome: RecordOutcome,
  usage: Usage | null,
  latencyMs: number,
  errorDetail?: string,
): Promise<void> {
  const inputTokens = usage?.inputTokens ?? 0;
  const cacheInputTokens = Math.max(0, Math.min(inputTokens, usage?.cacheTokens ?? 0));
  const cacheHit = ctx.cached || cacheInputTokens > 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const costMicros = computeCostMicros(
    inputTokens,
    outputTokens,
    ctx.inputPriceMicrosPerMillion,
    ctx.outputPriceMicrosPerMillion,
    cacheInputTokens,
    ctx.cacheInputPriceMicrosPerMillion,
  );
  const date = utcDateString();
  const logId = generateId();
  const minute = fiveMinuteFloor(Math.floor(Date.now() / 1000));

  // 1. Always: analytics 5-min bucket
  const analyticsDelta: AnalyticsDelta = {
    ...emptyDelta(),
    request_count: 1,
    success_count: outcome === 'success' ? 1 : 0,
    error_count: outcome === 'error' ? 1 : 0,
    cancelled_count: outcome === 'cancelled' ? 1 : 0,
    fallback_count: ctx.fallbackOccurred ? 1 : 0,
    attempt_count_total: ctx.attemptCount,
    input_tokens: inputTokens,
    cache_input_tokens: cacheInputTokens,
    output_tokens: outputTokens,
    usage_unknown_count: usage === null ? 1 : 0,
    cost_micros: costMicros,
    latency_ms_sum: latencyMs,
    latency_ms_count: 1,
    ttft_ms_sum: ctx.ttftMs ?? 0,
    ttft_ms_count: ctx.ttftMs !== undefined && ctx.ttftMs > 0 ? 1 : 0,
  };
  await upsertAnalyticsMinute(env.DB, {
    timestamp_minute: minute,
    model_card_id: ctx.modelCardId,
    channel_id: ctx.channelId,
    unified_model_id: ctx.unifiedModelId,
    channel_name: ctx.channelName,
    key_id: ctx.keyId,
  }, analyticsDelta);

  // 2. Always: key daily usage (budget authority)
  await upsertKeyDailyUsage(env.DB, ctx.keyId, date, {
    requests: 1, inputTokens, outputTokens, costMicros,
  });
  bumpKeyQuotaLedger(ctx.keyId, { requests: 1, inputTokens, outputTokens, costMicros });

  // 3. Optional: request_logs row (gated by master switch + level policy)
  const status = outcomeStatus(outcome);
  const levelEnabled = status === 'success' ? ctx.policy.logSuccess : ctx.policy.logErrors;
  const shouldLog = ctx.policy.logsEnabled && levelEnabled;
  if (!shouldLog) return;

  // Context encryption (only if logContext is enabled)
  let reqCtx: EncryptedContext | null = null;
  let resCtx: EncryptedContext | null = null;
  if (ctx.policy.logContext && (ctx.contextRequest || ctx.contextResponse)) {
    try {
      const contextKey = await deriveContextKey(env.MASTER_KEY);
      if (ctx.contextRequest) {
        reqCtx = await encryptContext(ctx.contextRequest, contextKey, logId);
      }
      if (ctx.contextResponse) {
        resCtx = await encryptContext(ctx.contextResponse, contextKey, logId);
      }
    } catch {
      // Context encryption failure → skip context, still write the log row
    }
  }

  const record: RequestLogRecord = {
    id: logId,
    timestamp: Math.floor(Date.now() / 1000),
    request_id: ctx.requestId,
    key_id: ctx.keyId,
    key_name: ctx.keyName,
    model_card_id: ctx.modelCardId,
    unified_model_id: ctx.unifiedModelId,
    channel_id: ctx.channelId,
    channel_name: ctx.channelName,
    status,
    stream: ctx.stream ? 1 : 0,
    cached: cacheHit ? 1 : 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_micros: costMicros,
    attempt_count: ctx.attemptCount,
    fallback: ctx.fallbackOccurred ? 1 : 0,
    latency_ms: latencyMs,
    ttft_ms: ctx.ttftMs ?? null,
    requested_protocol: ctx.requestedProtocol ?? null,
    error_detail: errorDetail ?? null,
    context_request_iv: reqCtx?.iv ?? null,
    context_request_tag: reqCtx?.tag ?? null,
    context_request_ciphertext: reqCtx?.ciphertext ?? null,
    context_response_iv: resCtx?.iv ?? null,
    context_response_tag: resCtx?.tag ?? null,
    context_response_ciphertext: resCtx?.ciphertext ?? null,
  };
  await putRequestLog(env.DB, record);
}

/** Record a request rejected before reaching upstream (quota / access control). */
export async function recordRejectedRequest(
  env: Env,
  ctx: {
    keyId: string;
    keyName: string;
    requestId: string;
    model: string | null;
    modelCardId: string | null;
    requestedProtocol?: string;
  },
  status: Exclude<RequestLogStatus, 'success' | 'error' | 'cancelled'>,
  latencyMs: number,
  policy: LogPolicy,
  errorDetail?: string,
): Promise<void> {
  // Rejected requests: always record analytics count (error/cancelled etc.)
  // but no key_daily_usage increment (no tokens consumed).
  if (ctx.keyId) {
    const delta = emptyDelta();
    delta.request_count = 1;
    delta.error_count = 1;
    delta.latency_ms_sum = latencyMs;
    delta.latency_ms_count = 1;
    await upsertAnalyticsMinute(env.DB, {
      timestamp_minute: fiveMinuteFloor(Math.floor(Date.now() / 1000)),
      model_card_id: ctx.modelCardId ?? '',
      channel_id: '',
      unified_model_id: ctx.model ?? '',
      channel_name: '',
      key_id: ctx.keyId,
    }, delta);
  }

  // Log row (gated by master switch + error level)
  const shouldLog = policy.logsEnabled && policy.logErrors;
  if (!shouldLog) return;

  const record: RequestLogRecord = {
    id: generateId(),
    timestamp: Math.floor(Date.now() / 1000),
    request_id: ctx.requestId,
    key_id: ctx.keyId,
    key_name: ctx.keyName,
    model_card_id: ctx.modelCardId,
    unified_model_id: ctx.model,
    channel_id: null,
    channel_name: null,
    status,
    stream: 0,
    cached: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
    attempt_count: 0,
    fallback: 0,
    latency_ms: latencyMs,
    ttft_ms: null,
    requested_protocol: ctx.requestedProtocol ?? null,
    error_detail: errorDetail ?? null,
  };
  await putRequestLog(env.DB, record);
}
