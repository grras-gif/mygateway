/**
 * Global model price baseline (KV-backed) — editable, used to prefill
 * channel-instance prices when a model is imported.
 */

import { modelPriceKey, KEY_PREFIX } from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';

export interface ModelPriceRow {
  provider_model_id: string;
  display_name: string;
  provider: string;
  input_price_micros_per_million: number;
  output_price_micros_per_million: number;
  cache_input_price_micros_per_million: number | null;
  currency: string;
  updated_at: number;
}

/** Look up baseline prices for a batch of provider model ids. */
export async function getModelPrices(
  db: KVNamespace,
  providerModelIds: string[],
): Promise<Map<string, ModelPriceRow>> {
  const map = new Map<string, ModelPriceRow>();
  for (const id of providerModelIds) {
    if (!id || map.has(id)) continue;
    const row = await kvGetJson<ModelPriceRow>(db, modelPriceKey(id));
    if (row) map.set(id, row);
  }
  return map;
}

export async function listModelPrices(db: KVNamespace): Promise<ModelPriceRow[]> {
  const rows = await kvListJson<ModelPriceRow>(db, KEY_PREFIX.modelPrice);
  return rows.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.provider_model_id.localeCompare(b.provider_model_id),
  );
}

export async function upsertModelPrice(
  db: KVNamespace,
  entry: {
    provider_model_id: string;
    display_name: string;
    provider: string;
    input_price_micros_per_million: number;
    output_price_micros_per_million: number;
    cache_input_price_micros_per_million: number | null;
    currency: string;
  },
): Promise<void> {
  await kvPutJson(db, modelPriceKey(entry.provider_model_id), {
    ...entry,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export async function deleteModelPrice(db: KVNamespace, providerModelId: string): Promise<void> {
  await kvDelete(db, modelPriceKey(providerModelId));
}
