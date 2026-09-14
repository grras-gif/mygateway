/** Channel and native protocol endpoint operations (Blob-backed). */

import type { ChannelProtocol, GatewayProtocol, ProtocolAuthScheme } from '../gateway/protocols.ts';
import {
  channelKey,
  channelModelKey,
  channelProtocolKey,
  channelProtocolPrefix,
  KEY_PREFIX,
  modelCardKey,
  modelIdentifierKey,
  providerModelKey,
} from '../kv/keys.ts';
import { kvDelete, kvGetJson, kvListJson, kvListKeys, kvPutJson } from '../kv/store.ts';

export interface ChannelRow {
  id: string;
  name: string;
  provider_type: 'openai' | 'openai_compatible';
  base_url: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_version: number;
  status: 'active' | 'disabled';
  notes: string | null;
  preset_id: string | null;
  short_code: string | null;
  created_at: number;
  updated_at: number;
}

/** Stored channel with its soft-delete marker. */
export interface StoredChannelRow extends ChannelRow {
  deleted_at: number | null;
}

/** Channel as returned to admin API (no key material). */
export interface ChannelPublic {
  id: string;
  name: string;
  provider_type: 'openai' | 'openai_compatible';
  base_url: string;
  has_api_key: boolean;
  status: 'active' | 'disabled';
  notes: string | null;
  preset_id: string | null;
  short_code: string | null;
  created_at: number;
  updated_at: number;
  protocols: ChannelProtocol[];
}

export interface ChannelWithProtocols extends ChannelRow {
  protocols: ChannelProtocol[];
}

export function toPublicChannel(row: ChannelWithProtocols): ChannelPublic {
  return {
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    base_url: row.base_url,
    has_api_key: true,
    status: row.status,
    notes: row.notes,
    preset_id: row.preset_id,
    short_code: row.short_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    protocols: row.protocols,
  };
}

export async function getChannelProtocols(
  db: BlobStore,
  channelId: string,
): Promise<ChannelProtocol[]> {
  const rows = await kvListJson<ChannelProtocol & { channel_id: string }>(
    db,
    channelProtocolPrefix(channelId),
  );
  return rows
    .map((row) => ({
      protocol: row.protocol,
      base_url: row.base_url,
      auth_scheme: row.auth_scheme,
      api_version: row.api_version,
    }))
    .sort((a, b) => a.protocol.localeCompare(b.protocol));
}

/** Raw channel row (including soft-deleted channels). */
export async function getChannelRow(
  db: BlobStore,
  id: string,
): Promise<StoredChannelRow | null> {
  return kvGetJson<StoredChannelRow>(db, channelKey(id));
}

export async function listChannels(db: BlobStore): Promise<ChannelWithProtocols[]> {
  const rows = await kvListJson<StoredChannelRow>(db, KEY_PREFIX.channel);
  const active = rows
    .filter((row) => row.deleted_at === null || row.deleted_at === undefined)
    .sort((a, b) => b.created_at - a.created_at);
  return Promise.all(
    active.map(async (row) => ({
      ...stripDeleted(row),
      protocols: await getChannelProtocols(db, row.id),
    })),
  );
}

function stripDeleted(row: StoredChannelRow): ChannelRow {
  const { deleted_at: _deletedAt, ...channel } = row;
  return channel;
}

export async function getChannel(db: BlobStore, id: string): Promise<ChannelWithProtocols | null> {
  const row = await getChannelRow(db, id);
  if (!row || (row.deleted_at !== null && row.deleted_at !== undefined)) return null;
  return { ...stripDeleted(row), protocols: await getChannelProtocols(db, id) };
}

export async function createChannel(
  db: BlobStore,
  channel: Omit<ChannelRow, 'created_at' | 'updated_at'>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row: StoredChannelRow = { ...channel, created_at: now, updated_at: now, deleted_at: null };
  await kvPutJson(db, channelKey(channel.id), row);
}

export interface ChannelProtocolInput {
  protocol: GatewayProtocol;
  base_url: string;
  auth_scheme: ProtocolAuthScheme;
  api_version?: string | null;
}

export async function replaceChannelProtocols(
  db: BlobStore,
  channelId: string,
  protocols: ChannelProtocolInput[],
): Promise<void> {
  const existing = await kvListKeys(db, channelProtocolPrefix(channelId));
  await Promise.all(existing.map((key) => db.delete(key)));
  for (const entry of protocols) {
    await kvPutJson(db, channelProtocolKey(channelId, entry.protocol), {
      channel_id: channelId,
      protocol: entry.protocol,
      base_url: entry.base_url,
      auth_scheme: entry.auth_scheme,
      api_version: entry.api_version ?? null,
    });
  }
}

export async function updateChannel(
  db: BlobStore,
  id: string,
  updates: {
    name?: string;
    base_url?: string;
    api_key_ciphertext?: string;
    api_key_iv?: string;
    status?: string;
    notes?: string | null;
    preset_id?: string | null;
    short_code?: string | null;
  },
): Promise<void> {
  const row = await getChannelRow(db, id);
  if (!row) return;
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.base_url !== undefined) row.base_url = updates.base_url;
  if (updates.api_key_ciphertext !== undefined) row.api_key_ciphertext = updates.api_key_ciphertext;
  if (updates.api_key_iv !== undefined) row.api_key_iv = updates.api_key_iv;
  if (updates.status !== undefined) row.status = updates.status as 'active' | 'disabled';
  if (updates.notes !== undefined) row.notes = updates.notes;
  if (updates.preset_id !== undefined) row.preset_id = updates.preset_id;
  if (updates.short_code !== undefined) row.short_code = updates.short_code;
  row.updated_at = Math.floor(Date.now() / 1000);
  await kvPutJson(db, channelKey(id), row);
}

export async function softDeleteChannel(db: BlobStore, id: string): Promise<void> {
  const row = await getChannelRow(db, id);
  if (!row) return;
  const now = Math.floor(Date.now() / 1000);
  row.deleted_at = now;
  row.updated_at = now;
  await kvPutJson(db, channelKey(id), row);
}

/**
 * Check if a channel is referenced by any active model instance.
 */
export async function isChannelReferenced(db: BlobStore, channelId: string): Promise<boolean> {
  const instances = await kvListJson<ChannelModelLike>(db, KEY_PREFIX.channelModel);
  return instances.some(
    (instance) =>
      instance.channel_id === channelId
      && (instance.deleted_at === null || instance.deleted_at === undefined),
  );
}

interface ChannelModelLike {
  id: string;
  model_card_id: string;
  channel_id: string;
  deleted_at?: number | null;
}

export interface ChannelDeleteModelImpact {
  model_card_id: string;
  unified_model_id: string;
  display_name: string;
  channel_instances: number;
  total_instances: number;
  remaining_instances: number;
  will_delete_model: boolean;
}

/** Read-only impact used before the destructive confirmation. */
export async function getChannelDeleteImpact(
  db: BlobStore,
  channelId: string,
): Promise<ChannelDeleteModelImpact[]> {
  const [instances, cards] = await Promise.all([
    kvListJson<ChannelModelLike>(db, KEY_PREFIX.channelModel),
    kvListJson<{ id: string; unified_model_id: string; display_name: string; deleted_at?: number | null }>(
      db,
      KEY_PREFIX.modelCard,
    ),
  ]);
  const liveInstances = instances.filter(
    (instance) => instance.deleted_at === null || instance.deleted_at === undefined,
  );
  const liveCards = cards.filter(
    (card) => card.deleted_at === null || card.deleted_at === undefined,
  );

  const impacts: ChannelDeleteModelImpact[] = [];
  for (const card of liveCards) {
    const totalInstances = liveInstances.filter((i) => i.model_card_id === card.id).length;
    const channelInstances = liveInstances.filter(
      (i) => i.model_card_id === card.id && i.channel_id === channelId,
    ).length;
    if (channelInstances === 0) continue;
    const remainingInstances = Math.max(0, totalInstances - channelInstances);
    impacts.push({
      model_card_id: card.id,
      unified_model_id: card.unified_model_id,
      display_name: card.display_name,
      channel_instances: channelInstances,
      total_instances: totalInstances,
      remaining_instances: remainingInstances,
      will_delete_model: remainingInstances === 0,
    });
  }
  return impacts.sort((a, b) => a.unified_model_id.localeCompare(b.unified_model_id));
}

/** Soft-delete model cards that became unroutable after a channel was removed. */
export async function softDeleteOrphanModelCards(
  db: BlobStore,
  modelCardIds: string[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const instances = await kvListJson<ChannelModelLike>(db, KEY_PREFIX.channelModel);
  for (const modelCardId of modelCardIds) {
    const remaining = instances.filter(
      (instance) =>
        instance.model_card_id === modelCardId
        && (instance.deleted_at === null || instance.deleted_at === undefined),
    ).length;
    if (remaining > 0) continue;

    const identifiers = await kvListJson<{ identifier: string; model_card_id: string }>(
      db,
      KEY_PREFIX.modelIdentifier,
    );
    await Promise.all(
      identifiers
        .filter((identifier) => identifier.model_card_id === modelCardId)
        .map((identifier) => kvDelete(db, modelIdentifierKey(identifier.identifier))),
    );

    const card = await kvGetJson<{
      id: string;
      unified_model_id: string;
      display_name: string;
      status: 'active' | 'disabled';
      created_at: number;
      updated_at: number;
      deleted_at?: number | null;
    }>(db, modelCardKey(modelCardId));
    if (card) {
      card.deleted_at = now;
      card.updated_at = now;
      card.unified_model_id = `deleted:${modelCardId}:${now}`;
      await kvPutJson(db, modelCardKey(modelCardId), card);
    }

    const providerModels = await kvListJson<{
      channel_id: string;
      provider_model_id: string;
      imported_model_card_id: string | null;
      updated_at: number;
    }>(db, KEY_PREFIX.providerModel);
    for (const providerModel of providerModels) {
      if (providerModel.imported_model_card_id !== modelCardId) continue;
      providerModel.imported_model_card_id = null;
      providerModel.updated_at = now;
      await kvPutJson(
        db,
        providerModelKey(providerModel.channel_id, providerModel.provider_model_id),
        providerModel,
      );
    }
  }
}

/**
 * Hard-delete all model instances referencing a channel (cascade on channel delete).
 */
export async function softDeleteInstancesByChannel(db: BlobStore, channelId: string): Promise<void> {
  const instances = await kvListJson<ChannelModelLike>(db, KEY_PREFIX.channelModel);
  const doomed = instances.filter((instance) => instance.channel_id === channelId);
  if (doomed.length === 0) return;
  const doomedIds = new Set(doomed.map((instance) => instance.id));

  const identifiers = await kvListJson<{ identifier: string; channel_model_id: string | null }>(
    db,
    KEY_PREFIX.modelIdentifier,
  );
  await Promise.all(
    identifiers
      .filter((identifier) => identifier.channel_model_id && doomedIds.has(identifier.channel_model_id))
      .map((identifier) => kvDelete(db, modelIdentifierKey(identifier.identifier))),
  );
  await Promise.all(doomed.map((instance) => kvDelete(db, channelModelKey(instance.id))));
}
