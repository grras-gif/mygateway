/**
 * Idempotent runtime seed for baseline KV data.
 *
 * KV has no schema migration step, so the baseline system settings and the
 * editable model-price library that used to live in `migrations/0001_initial.sql`
 * are written here on the first backend request. Existing keys are never
 * overwritten, and a `bootstrap:seed` marker keeps later requests O(1).
 */

import { bootstrapKey } from '../kv/keys.ts';
import { kvGetJson, kvPutJson } from '../kv/store.ts';
import { getSetting, setSetting } from './settings.ts';
import { listModelPrices, upsertModelPrice } from './model-prices.ts';

/** Bump when the baseline data set changes so existing deployments re-seed. */
const SEED_VERSION = 1;

interface SeedMarker {
  version: number;
  seeded_at: number;
}

const DEFAULT_SETTINGS: Record<string, string> = {
  request_logs_enabled: 'true',
  log_success: 'true',
  log_errors: 'true',
  log_context: 'false',
  context_retention_hours: '24',
  request_log_retention_days: '7',
};

interface SeedModelPrice {
  provider_model_id: string;
  display_name: string;
  provider: string;
  input_price_micros_per_million: number;
  output_price_micros_per_million: number;
  cache_input_price_micros_per_million: number | null;
  currency: string;
}

const DEFAULT_MODEL_PRICES: SeedModelPrice[] = [
  { provider_model_id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', provider: 'deepseek', input_price_micros_per_million: 140000, output_price_micros_per_million: 280000, cache_input_price_micros_per_million: 2800, currency: 'USD' },
  { provider_model_id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro', provider: 'deepseek', input_price_micros_per_million: 435000, output_price_micros_per_million: 870000, cache_input_price_micros_per_million: 3625, currency: 'USD' },
  { provider_model_id: 'glm-5.1', display_name: 'GLM-5.1', provider: 'zai', input_price_micros_per_million: 1400000, output_price_micros_per_million: 4400000, cache_input_price_micros_per_million: 260000, currency: 'USD' },
  { provider_model_id: 'glm-5', display_name: 'GLM-5', provider: 'zai', input_price_micros_per_million: 1000000, output_price_micros_per_million: 3200000, cache_input_price_micros_per_million: 200000, currency: 'USD' },
  { provider_model_id: 'glm-4.7', display_name: 'GLM-4.7', provider: 'zai', input_price_micros_per_million: 600000, output_price_micros_per_million: 2200000, cache_input_price_micros_per_million: 110000, currency: 'USD' },
  { provider_model_id: 'qwen3.7-max', display_name: 'Qwen3.7 Max', provider: 'alibaba_cloud_intl', input_price_micros_per_million: 2500000, output_price_micros_per_million: 7500000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'qwen3.7-plus', display_name: 'Qwen3.7 Plus', provider: 'alibaba_cloud_intl', input_price_micros_per_million: 400000, output_price_micros_per_million: 1600000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'qwen3.6-flash', display_name: 'Qwen3.6 Flash', provider: 'alibaba_cloud_intl', input_price_micros_per_million: 250000, output_price_micros_per_million: 1500000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'seed-2-0-pro-260328', display_name: 'Seed 2.0 Pro', provider: 'byteplus_modelark', input_price_micros_per_million: 500000, output_price_micros_per_million: 3000000, cache_input_price_micros_per_million: 100000, currency: 'USD' },
  { provider_model_id: 'seed-2-0-lite-260428', display_name: 'Seed 2.0 Lite', provider: 'byteplus_modelark', input_price_micros_per_million: 250000, output_price_micros_per_million: 2000000, cache_input_price_micros_per_million: 50000, currency: 'USD' },
  { provider_model_id: 'seed-2-0-mini-260428', display_name: 'Seed 2.0 Mini', provider: 'byteplus_modelark', input_price_micros_per_million: 100000, output_price_micros_per_million: 400000, cache_input_price_micros_per_million: 20000, currency: 'USD' },
  { provider_model_id: 'gemini-3.6-flash', display_name: 'Gemini 3.6 Flash', provider: 'google_gemini', input_price_micros_per_million: 1500000, output_price_micros_per_million: 7500000, cache_input_price_micros_per_million: 150000, currency: 'USD' },
  { provider_model_id: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', provider: 'google_gemini', input_price_micros_per_million: 1500000, output_price_micros_per_million: 9000000, cache_input_price_micros_per_million: 150000, currency: 'USD' },
  { provider_model_id: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash-Lite', provider: 'google_gemini', input_price_micros_per_million: 300000, output_price_micros_per_million: 2500000, cache_input_price_micros_per_million: 30000, currency: 'USD' },
  { provider_model_id: 'openai/gpt-oss-120b', display_name: 'GPT OSS 120B', provider: 'groq', input_price_micros_per_million: 150000, output_price_micros_per_million: 600000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'openai/gpt-oss-20b', display_name: 'GPT OSS 20B', provider: 'groq', input_price_micros_per_million: 75000, output_price_micros_per_million: 300000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'llama-3.3-70b-versatile', display_name: 'Llama 3.3 70B', provider: 'groq', input_price_micros_per_million: 590000, output_price_micros_per_million: 790000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'MiniMax-M3', display_name: 'MiniMax M3', provider: 'minimax_intl', input_price_micros_per_million: 300000, output_price_micros_per_million: 1200000, cache_input_price_micros_per_million: 60000, currency: 'USD' },
  { provider_model_id: 'MiniMax-M2.7', display_name: 'MiniMax M2.7', provider: 'minimax_intl', input_price_micros_per_million: 300000, output_price_micros_per_million: 1200000, cache_input_price_micros_per_million: 60000, currency: 'USD' },
  { provider_model_id: 'MiniMax-M2.7-highspeed', display_name: 'MiniMax M2.7 Highspeed', provider: 'minimax_intl', input_price_micros_per_million: 600000, output_price_micros_per_million: 2400000, cache_input_price_micros_per_million: 60000, currency: 'USD' },
  { provider_model_id: 'grok-4.5', display_name: 'Grok 4.5', provider: 'xai', input_price_micros_per_million: 2000000, output_price_micros_per_million: 6000000, cache_input_price_micros_per_million: 300000, currency: 'USD' },
  { provider_model_id: 'grok-4.3', display_name: 'Grok 4.3', provider: 'xai', input_price_micros_per_million: 1250000, output_price_micros_per_million: 2500000, cache_input_price_micros_per_million: 200000, currency: 'USD' },
  { provider_model_id: 'mistral-large-2512', display_name: 'Mistral Large 3', provider: 'mistral', input_price_micros_per_million: 500000, output_price_micros_per_million: 1500000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'mistral-medium-3-5', display_name: 'Mistral Medium 3.5', provider: 'mistral', input_price_micros_per_million: 1500000, output_price_micros_per_million: 7500000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'mistral-small-2603', display_name: 'Mistral Small 4', provider: 'mistral', input_price_micros_per_million: 150000, output_price_micros_per_million: 600000, cache_input_price_micros_per_million: null, currency: 'USD' },
  { provider_model_id: 'gpt-5.4', display_name: 'GPT-5.4', provider: 'openai', input_price_micros_per_million: 2500000, output_price_micros_per_million: 15000000, cache_input_price_micros_per_million: 250000, currency: 'USD' },
  { provider_model_id: 'gpt-5.4-mini', display_name: 'GPT-5.4 mini', provider: 'openai', input_price_micros_per_million: 750000, output_price_micros_per_million: 4500000, cache_input_price_micros_per_million: 75000, currency: 'USD' },
  { provider_model_id: 'gpt-5.4-nano', display_name: 'GPT-5.4 nano', provider: 'openai', input_price_micros_per_million: 200000, output_price_micros_per_million: 1250000, cache_input_price_micros_per_million: 20000, currency: 'USD' },
  { provider_model_id: 'claude-opus-5', display_name: 'Claude Opus 5', provider: 'anthropic', input_price_micros_per_million: 5000000, output_price_micros_per_million: 25000000, cache_input_price_micros_per_million: 500000, currency: 'USD' },
  { provider_model_id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', provider: 'anthropic', input_price_micros_per_million: 3000000, output_price_micros_per_million: 15000000, cache_input_price_micros_per_million: 300000, currency: 'USD' },
];

/**
 * Seed baseline settings and model prices once. Safe to call on every request:
 * a version marker short-circuits the work after the first successful run, and
 * existing keys are never overwritten.
 */
export async function ensureBootstrapData(db: KVNamespace): Promise<void> {
  const marker = await kvGetJson<SeedMarker>(db, bootstrapKey('seed'));
  if (marker?.version === SEED_VERSION) return;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await getSetting(db, key);
    if (existing === null) await setSetting(db, key, value);
  }

  const existingPrices = new Set((await listModelPrices(db)).map((row) => row.provider_model_id));
  for (const price of DEFAULT_MODEL_PRICES) {
    if (!existingPrices.has(price.provider_model_id)) await upsertModelPrice(db, price);
  }

  const seeded: SeedMarker = { version: SEED_VERSION, seeded_at: Math.floor(Date.now() / 1000) };
  await kvPutJson(db, bootstrapKey('seed'), seeded);
}
