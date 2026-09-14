/**
 * On-demand retention cleanup.
 *
 * This replaces the Cloudflare Cron Trigger: the admin endpoint
 * `POST /admin/api/system/cleanup` invokes it, so no scheduled job or extra
 * service is required. It prunes analytics buckets, request logs, encrypted
 * context previews, per-key daily usage, Management API audit records and
 * expired temporary Gateway Keys.
 */

import { Env, parseConfig } from '../env.ts';
import { cleanupAnalytics, cleanupContext, readAnalyticsSettings } from '../db/analytics.ts';
import { cleanupKeyDailyUsage, cleanupRequestLogs } from '../db/requests.ts';
import { cleanupManagementAudit } from '../db/management-keys.ts';
import { cleanupExpiredTemporaryGatewayKeys } from '../db/keys.ts';

/**
 * Per-key daily usage backs the weekly / monthly / yearly budgets, so it is
 * kept longer than the 30-day analytics window.
 */
const KEY_DAILY_USAGE_RETENTION_DAYS = 370;

export interface RetentionCleanupResult {
  analytics_buckets: number;
  request_logs: number;
  context_rows: number;
  key_daily_usage: number;
  management_audit: number;
  temporary_keys: number;
}

export async function runRetentionCleanup(env: Env): Promise<RetentionCleanupResult> {
  const { usageRetentionDays } = parseConfig(env);
  const analyticsSettings = await readAnalyticsSettings(env.DB);

  // Nullify context previews before deleting old logs so the privacy window is
  // enforced even when a log row is not yet past its deletion retention.
  const contextRows = await cleanupContext(env.DB, analyticsSettings.contextRetentionHours);

  const [analyticsBuckets, requestLogs, keyDailyUsage, managementAudit, temporaryKeys] =
    await Promise.all([
      cleanupAnalytics(env.DB, usageRetentionDays),
      cleanupRequestLogs(env.DB, analyticsSettings.requestLogRetentionDays),
      cleanupKeyDailyUsage(env.DB, KEY_DAILY_USAGE_RETENTION_DAYS),
      cleanupManagementAudit(env.DB, usageRetentionDays),
      cleanupExpiredTemporaryGatewayKeys(env.DB),
    ]);

  return {
    analytics_buckets: analyticsBuckets,
    request_logs: requestLogs,
    context_rows: contextRows,
    key_daily_usage: keyDailyUsage,
    management_audit: managementAudit,
    temporary_keys: temporaryKeys,
  };
}
