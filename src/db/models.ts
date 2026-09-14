/**
 * Model cards and channel model instances — KV-backed operations.
 */

import { parseCandidateProtocols, type ChannelProtocol } from '../gateway/protocols.ts';
import {
  channelModelKey,
  KEY_PREFIX,
  modelCardKey,
  modelIdentifierKey,
} from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvPutJson } from '../kv/store.ts';
import { getChannelProtocols, getChannelRow } from './channels.ts';

export interface ModelCardRow {
  id: string;
  unified_model_id: string;
  display_name: string;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

export interface StoredModelCardRow extends ModelCardRow {
  deleted_at: number | null;
}

export interface ChannelModelRow {
  id: string;
  model_card_id: string;
  channel_id: string;
  channel_model_id: string;
  public_model_alias: string;
  sort_order: number;
  status: 'active' | 'disabled';
  supports_stream_usage: 0 | 1;
  input_price_micros_per_million: number | null;
  output_price_micros_per_million: number | null;
  cache_input_price_micros_per_million: number | null;
  currency: string | null;
  plan_tokens_total: number | null;
  plan_tokens_remaining: number | null;
  plan_expires_at: number | null;
  manual_metadata_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredChannelModelRow extends ChannelModelRow {
  deleted_at: number | null;
}

export interface ModelIdentifierRow {
  identifier: string;
  identifier_type: 'unified' | 'alias';
  model_card_id: string;
  channel_model_id: string | null;
}

// --- Model Cards ---

export async function listModelCards(db: KVNamespace): Promise<ModelCardRow[]> {
  const rows = await kvListJson<StoredModelCardRow>(db, KEY_PREFIX.modelCard);
  return rows
    .filter((row) => row.deleted_at === null || row.deleted_at === undefined)
    .sort((a, b) => b.created_at - a.created_at)
    .map(({ deleted_at: _deletedAt, ...card }) => card);
}

export async function getModelCard(db: KVNamespace, id: string): Promise<ModelCardRow | null> {
  const row = await kvGetJson<StoredModelCardRow>(db, modelCardKey(id));
  if (!row || (row.deleted_at !== null && row.deleted_at !== undefined)) return null;
  const { deleted_at: _deletedAt, ...card } = row;
  return card;
}

export async function createModelCard(
  db: KVNamespace,
  card: { id: string; unified_model_id: string; display_name: string; status?: string },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row: StoredModelCardRow = {
    id: card.id,
    unified_model_id: card.unified_model_id,
    display_name: card.display_name,
    status: (card.status ?? 'active') as 'active' | 'disabled',
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await kvPutJson(db, modelCardKey(card.id), row);
}

export async function updateModelCard(
  db: KVNamespace,
  id: string,
  updates: { display_name?: string; status?: string },
): Promise<void> {
  const row = await kvGetJson<StoredModelCardRow>(db, modelCardKey(id));
  if (!row || (row.deleted_at !== null && row.deleted_at !== undefined)) return;
  if (updates.display_name !== undefined) row.display_name = updates.display_name;
  if (updates.status !== undefined) row.status = updates.status as 'active' | 'disabled';
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, modelCardKey(id), row);
}

export async function softDeleteModelCard(db: KVNamespace, id: string): Promise<void> {
  const row = await kvGetJson<StoredModelCardRow>(db, modelCardKey(id));
  if (!row) return;
  const now = Math.floor(Date.now() / 1000);
  row.deleted_at = now;
  row.updated_at = now;
  await kvPutJson(db, modelCardKey(id), row);
}

/** Hard-delete a model card record (rollback of a partially created card). */
export async function deleteModelCard(db: KVNamespace, id: string): Promise<void> {
  await kvDelete(db, modelCardKey(id));
}

// --- Channel Model Instances ---

export async function listChannelModels(
  db: KVNamespace,
  modelCardId: string,
): Promise<ChannelModelRow[]> {
  const rows = await kvListJson<StoredChannelModelRow>(db, KEY_PREFIX.channelModel);
  return rows
    .filter(
      (row) =>
        row.model_card_id === modelCardId
        && (row.deleted_at === null || row.deleted_at === undefined),
    )
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(({ deleted_at: _deletedAt, ...instance }) => instance);
}

export async function createChannelModel(
  db: KVNamespace,
  instance: Omit<ChannelModelRow, 'created_at' | 'updated_at' | 'manual_metadata_updated_at'>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row: StoredChannelModelRow = {
    ...instance,
    created_at: now,
    updated_at: now,
    manual_metadata_updated_at: null,
    deleted_at: null,
  };
  await kvPutJson(db, channelModelKey(instance.id), row);
}

export async function getChannelModelForCardChannel(
  db: KVNamespace,
  modelCardId: string,
  channelId: string,
): Promise<ChannelModelRow | null> {
  const instances = await listChannelModels(db, modelCardId);
  return instances.find((instance) => instance.channel_id === channelId) ?? null;
}

export async function reorderInstances(
  db: KVNamespace,
  modelCardId: string,
  instanceIds: string[],
): Promise<void> {
  for (let index = 0; index < instanceIds.length; index++) {
    const row = await kvGetJson<StoredChannelModelRow>(db, channelModelKey(instanceIds[index]));
    if (!row || row.model_card_id !== modelCardId) continue;
    row.sort_order = index;
    row.updated_at = Math.floor(Date.now() / 1000);
    await kvPutJson(db, channelModelKey(instanceIds[index]), row);
  }
}

export async function countChannelModels(db: KVNamespace, modelCardId: string): Promise<number> {
  const instances = await listChannelModels(db, modelCardId);
  return instances.length;
}

/** Update pricing / stream metadata on a single instance. */
export async function updateChannelModelInstance(
  db: KVNamespace,
  instanceId: string,
  updates: {
    input_price_micros_per_million?: number | null;
    output_price_micros_per_million?: number | null;
    cache_input_price_micros_per_million?: number | null;
    currency?: string;
    supports_stream_usage?: 0 | 1;
  },
): Promise<void> {
  const row = await kvGetJson<StoredChannelModelRow>(db, channelModelKey(instanceId));
  if (!row) return;
  if (updates.input_price_micros_per_million !== undefined) {
    row.input_price_micros_per_million = updates.input_price_micros_per_million;
  }
  if (updates.output_price_micros_per_million !== undefined) {
    row.output_price_micros_per_million = updates.output_price_micros_per_million;
  }
  if (updates.cache_input_price_micros_per_million !== undefined) {
    row.cache_input_price_micros_per_million = updates.cache_input_price_micros_per_million;
  }
  if (updates.currency !== undefined) row.currency = updates.currency;
  if (updates.supports_stream_usage !== undefined) {
    row.supports_stream_usage = updates.supports_stream_usage;
  }
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, channelModelKey(instanceId), row);
}

/** Hard-delete a single instance (rollback). */
export async function deleteChannelModel(db: KVNamespace, instanceId: string): Promise<void> {
  await kvDelete(db, channelModelKey(instanceId));
}

/** Hard-delete every instance of a model card (rollback). */
export async function deleteChannelModelsByModelCard(
  db: KVNamespace,
  modelCardId: string,
): Promise<void> {
  const rows = await kvListJson<StoredChannelModelRow>(db, KEY_PREFIX.channelModel);
  await Promise.all(
    rows
      .filter((row) => row.model_card_id === modelCardId)
      .map((row) => kvDelete(db, channelModelKey(row.id))),
  );
}

/** Soft-delete every instance of a model card (admin model delete). */
export async function softDeleteChannelModelsByModelCard(
  db: KVNamespace,
  modelCardId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await kvListJson<StoredChannelModelRow>(db, KEY_PREFIX.channelModel);
  for (const row of rows) {
    if (row.model_card_id !== modelCardId) continue;
    row.deleted_at = now;
    row.updated_at = now;
    await kvPutJson(db, channelModelKey(row.id), row);
  }
}

// --- Model Identifiers ---

export async function resolveIdentifier(
  db: KVNamespace,
  identifier: string,
): Promise<ModelIdentifierRow | null> {
  return kvGetJson<ModelIdentifierRow>(db, modelIdentifierKey(identifier));
}

export async function createIdentifier(
  db: KVNamespace,
  ident: ModelIdentifierRow,
): Promise<void> {
  await kvPutJson(db, modelIdentifierKey(ident.identifier), ident);
}

export async function deleteIdentifier(db: KVNamespace, identifier: string): Promise<void> {
  await kvDelete(db, modelIdentifierKey(identifier));
}

/** Delete every identifier that belongs to a model card. */
export async function deleteIdentifiersByModelCard(
  db: KVNamespace,
  modelCardId: string,
): Promise<void> {
  const rows = await kvListJson<ModelIdentifierRow>(db, KEY_PREFIX.modelIdentifier);
  await Promise.all(
    rows
      .filter((row) => row.model_card_id === modelCardId)
      .map((row) => kvDelete(db, modelIdentifierKey(row.identifier))),
  );
}

/**
 * Full cascade used by the admin model delete: free the unified id, drop
 * identifiers, soft-delete instances, and detach provider-model imports.
 */
export async function deleteModelCardCascade(db: KVNamespace, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await deleteIdentifiersByModelCard(db, id);

  const card = await kvGetJson<StoredModelCardRow>(db, modelCardKey(id));
  if (card) {
    card.deleted_at = now;
    card.updated_at = now;
    card.unified_model_id = `deleted:${id}:${now}`;
    await kvPutJson(db, modelCardKey(id), card);
  }
  await softDeleteChannelModelsByModelCard(db, id);

  const providerModels = await kvListJson<{
    channel_id: string;
    provider_model_id: string;
    imported_model_card_id: string | null;
    updated_at: number;
  }>(db, KEY_PREFIX.providerModel);
  for (const providerModel of providerModels) {
    if (providerModel.imported_model_card_id !== id) continue;
    providerModel.imported_model_card_id = null;
    providerModel.updated_at = now;
    await kvPutJson(
      db,
      `${KEY_PREFIX.providerModel}${providerModel.channel_id}:${providerModel.provider_model_id}`,
      providerModel,
    );
  }
}

// --- Routing ---

export interface CandidateRow {
  channel_model_id_pk: string;
  channel_model_id: string;
  public_model_alias: string;
  sort_order: number;
  supports_stream_usage: 0 | 1;
  input_price_micros_per_million: number | null;
  output_price_micros_per_million: number | null;
  cache_input_price_micros_per_million: number | null;
  channel_id: string;
  channel_name: string;
  provider_type: string;
  base_url: string;
  protocols: ChannelProtocol[];
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_version: number;
}

export interface CandidateQueryRow extends Omit<CandidateRow, 'protocols'> {
  protocols_json?: string;
}

export function hydrateCandidate(row: CandidateQueryRow): CandidateRow {
  return {
    ...row,
    protocols: parseCandidateProtocols(row.protocols_json, row.base_url),
  };
}

async function buildCandidate(
  db: KVNamespace,
  instance: ChannelModelRow,
): Promise<CandidateRow | null> {
  const channel = await getChannelRow(db, instance.channel_id);
  if (!channel || (channel.deleted_at !== null && channel.deleted_at !== undefined)) return null;
  if (channel.status !== 'active') return null;
  const protocols = await getChannelProtocols(db, channel.id);
  return hydrateCandidate({
    channel_model_id_pk: instance.id,
    channel_model_id: instance.channel_model_id,
    public_model_alias: instance.public_model_alias,
    sort_order: instance.sort_order,
    supports_stream_usage: instance.supports_stream_usage,
    input_price_micros_per_million: instance.input_price_micros_per_million,
    output_price_micros_per_million: instance.output_price_micros_per_million,
    cache_input_price_micros_per_million: instance.cache_input_price_micros_per_million,
    channel_id: channel.id,
    channel_name: channel.name,
    provider_type: channel.provider_type,
    base_url: channel.base_url,
    protocols_json: JSON.stringify(protocols),
    api_key_ciphertext: channel.api_key_ciphertext,
    api_key_iv: channel.api_key_iv,
    api_key_version: channel.api_key_version,
  });
}

/**
 * Get all enabled candidates for a model card, joined with channel info.
 */
export async function getCandidatesForModel(
  db: KVNamespace,
  modelCardId: string,
): Promise<CandidateRow[]> {
  const instances = (await listChannelModels(db, modelCardId))
    .filter((instance) => instance.status === 'active')
    .sort((a, b) => (a.sort_order - b.sort_order) || a.id.localeCompare(b.id));
  const candidates = await Promise.all(instances.map((instance) => buildCandidate(db, instance)));
  return candidates.filter((candidate): candidate is CandidateRow => candidate !== null);
}

export interface ResolvedRoute {
  identifier_type: 'unified' | 'alias';
  model_card_id: string;
  direct_channel_model_id: string | null;
  candidates: CandidateRow[];
}

/**
 * Resolve a model identifier to its card and enabled candidates.
 * Returns null when the identifier is unknown (unknown model).
 * When the identifier exists but every candidate is unavailable, `candidates`
 * is empty so callers can distinguish unknown from temporarily unavailable.
 */
export async function resolveRoute(
  db: KVNamespace,
  identifier: string,
): Promise<ResolvedRoute | null> {
  const ident = await resolveIdentifier(db, identifier);
  if (!ident) return null;

  const card = await getModelCard(db, ident.model_card_id);
  const candidates: CandidateRow[] = [];
  if (card && card.status === 'active') {
    const instances = (await listChannelModels(db, ident.model_card_id))
      .filter((instance) => instance.status === 'active')
      .filter(
        (instance) =>
          ident.identifier_type === 'unified' || instance.id === ident.channel_model_id,
      )
      .sort((a, b) => (a.sort_order - b.sort_order) || a.id.localeCompare(b.id));
    for (const instance of instances) {
      const candidate = await buildCandidate(db, instance);
      if (candidate) candidates.push(candidate);
    }
  }

  return {
    identifier_type: ident.identifier_type,
    model_card_id: ident.model_card_id,
    direct_channel_model_id: ident.channel_model_id,
    candidates,
  };
}
