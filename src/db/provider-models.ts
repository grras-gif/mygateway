/** Provider-model inventory and discovery state (KV-backed). */

import {
  discoveryKey,
  KEY_PREFIX,
  providerModelKey,
  providerModelPrefix,
} from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';
import { listChannels } from './channels.ts';

export type ProviderModelSource = 'discovered' | 'manual' | 'preset';
export type ProviderModelAvailability = 'available' | 'missing' | 'unknown';

export interface ProviderModelRow {
  channel_id: string;
  provider_model_id: string;
  display_name: string;
  source: ProviderModelSource;
  availability: ProviderModelAvailability;
  capabilities_json: string | null;
  imported_model_card_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DiscoveryStateRow {
  channel_id: string;
  status: 'never' | 'ok' | 'error';
  result_hash: string | null;
  model_count: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  error_summary: string | null;
}

export interface DiscoveredProviderModel {
  id: string;
  displayName: string;
  capabilities?: unknown;
}

export interface ChannelModelSummary {
  channel_id: string;
  model_count: number;
  available_count: number;
  imported_count: number;
  preview: Array<{ provider_model_id: string; display_name: string }>;
  discovery_status: DiscoveryStateRow['status'];
  last_success_at: number | null;
  error_summary: string | null;
}

/** One pass over channels + inventory; never queries per card repeatedly. */
export async function listChannelModelSummaries(db: KVNamespace): Promise<ChannelModelSummary[]> {
  const [channels, providerModels, discoveryStates] = await Promise.all([
    listChannels(db),
    kvListJson<ProviderModelRow>(db, KEY_PREFIX.providerModel),
    kvListJson<DiscoveryStateRow>(db, KEY_PREFIX.discovery),
  ]);
  const discoveryByChannel = new Map(discoveryStates.map((state) => [state.channel_id, state]));

  return channels.map((channel) => {
    const models = providerModels.filter((model) => model.channel_id === channel.id);
    const preview = models
      .filter((model) => model.availability === 'available')
      .sort((a, b) => a.provider_model_id.localeCompare(b.provider_model_id))
      .slice(0, 3)
      .map((model) => ({
        provider_model_id: model.provider_model_id,
        display_name: model.display_name,
      }));
    const discovery = discoveryByChannel.get(channel.id);
    return {
      channel_id: channel.id,
      model_count: models.length,
      available_count: models.filter((model) => model.availability === 'available').length,
      imported_count: models.filter((model) => model.imported_model_card_id !== null).length,
      preview,
      discovery_status: discovery?.status ?? 'never',
      last_success_at: discovery?.last_success_at ?? null,
      error_summary: discovery?.error_summary ?? null,
    };
  });
}

export async function listProviderModels(db: KVNamespace, channelId: string): Promise<ProviderModelRow[]> {
  const models = await kvListJson<ProviderModelRow>(db, providerModelPrefix(channelId));
  return models.sort((a, b) => {
    const availabilityRank = (row: ProviderModelRow) => (row.availability === 'available' ? 0 : 1);
    return availabilityRank(a) - availabilityRank(b)
      || a.provider_model_id.localeCompare(b.provider_model_id);
  });
}

export async function getProviderModel(
  db: KVNamespace,
  channelId: string,
  providerModelId: string,
): Promise<ProviderModelRow | null> {
  return kvGetJson<ProviderModelRow>(db, providerModelKey(channelId, providerModelId));
}

export async function getDiscoveryState(db: KVNamespace, channelId: string): Promise<DiscoveryStateRow | null> {
  return kvGetJson<DiscoveryStateRow>(db, discoveryKey(channelId));
}

export async function saveDiscoveryError(db: KVNamespace, channelId: string, message: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await getDiscoveryState(db, channelId);
  const state: DiscoveryStateRow = {
    channel_id: channelId,
    status: 'error',
    result_hash: existing?.result_hash ?? null,
    model_count: existing?.model_count ?? 0,
    last_attempt_at: now,
    last_success_at: existing?.last_success_at ?? null,
    error_summary: message.slice(0, 300),
  };
  await kvPutJson(db, discoveryKey(channelId), state);
}

export async function syncDiscoveredProviderModels(
  db: KVNamespace,
  channelId: string,
  models: DiscoveredProviderModel[],
  resultHash: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const state = await getDiscoveryState(db, channelId);
  if (state?.result_hash !== resultHash) {
    const ids = new Set(models.map((model) => model.id));
    const current = await listProviderModels(db, channelId);
    for (const row of current) {
      if (row.source === 'discovered' && !ids.has(row.provider_model_id)) {
        row.availability = 'missing';
        row.updated_at = now;
        await kvPutJson(db, providerModelKey(channelId, row.provider_model_id), row);
      }
    }
    for (const model of models) {
      const existing = await getProviderModel(db, channelId, model.id);
      const row: ProviderModelRow = {
        channel_id: channelId,
        provider_model_id: model.id,
        display_name: model.displayName,
        source: existing?.source === 'manual' ? 'manual' : 'discovered',
        availability: 'available',
        capabilities_json: model.capabilities === undefined ? null : JSON.stringify(model.capabilities),
        imported_model_card_id: existing?.imported_model_card_id ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await kvPutJson(db, providerModelKey(channelId, model.id), row);
    }
  }
  const updated: DiscoveryStateRow = {
    channel_id: channelId,
    status: 'ok',
    result_hash: resultHash,
    model_count: models.length,
    last_attempt_at: now,
    last_success_at: now,
    error_summary: null,
  };
  await kvPutJson(db, discoveryKey(channelId), updated);
}

export async function addManualProviderModel(
  db: KVNamespace,
  channelId: string,
  providerModelId: string,
  displayName: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await getProviderModel(db, channelId, providerModelId);
  const row: ProviderModelRow = {
    channel_id: channelId,
    provider_model_id: providerModelId,
    display_name: displayName,
    source: 'manual',
    availability: 'available',
    capabilities_json: existing?.capabilities_json ?? null,
    imported_model_card_id: existing?.imported_model_card_id ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await kvPutJson(db, providerModelKey(channelId, providerModelId), row);
}

export async function deleteProviderModel(db: KVNamespace, channelId: string, providerModelId: string): Promise<void> {
  await kvDelete(db, providerModelKey(channelId, providerModelId));
}

export async function markProviderModelImported(
  db: KVNamespace,
  channelId: string,
  providerModelId: string,
  modelCardId: string,
): Promise<void> {
  const row = await getProviderModel(db, channelId, providerModelId);
  if (!row) return;
  row.imported_model_card_id = modelCardId;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, providerModelKey(channelId, providerModelId), row);
}
