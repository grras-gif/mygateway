import type { Env } from '../env.ts';
import { jsonResponse } from '../http/json-response.ts';
import { listChannels } from '../db/channels.ts';
import { listChannelModels, listModelCards } from '../db/models.ts';
import { listGatewayKeys, toPublicKey } from '../db/keys.ts';
import { cachedProviderBalances } from '../admin/provider-balances.ts';

type SetupState = 'needs_channel' | 'needs_model' | 'needs_gateway_key' | 'ready';

function recommendedAction(state: SetupState): string {
  if (state === 'needs_channel') return 'add_channel';
  if (state === 'needs_model') return 'configure_model';
  if (state === 'needs_gateway_key') return 'create_gateway_key';
  return 'none';
}

/** A compact, secret-free bootstrap view for agents connecting to a deployment. */
export async function handleManagementOverview(
  env: Env,
  permission: 'read' | 'write',
): Promise<Response> {
  const [channels, cards, keyRows] = await Promise.all([
    listChannels(env.DB),
    listModelCards(env.DB),
    listGatewayKeys(env.DB),
  ]);
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  const modelMap = new Map<string, {
    id: string;
    unified_model_id: string;
    display_name: string;
    status: 'active' | 'disabled';
    instances: Array<{
      id: string;
      channel_id: string;
      channel_name: string;
      provider_model_id: string;
      public_model_alias: string;
      sort_order: number;
      status: 'active' | 'disabled';
      channel_status: 'active' | 'disabled';
      pricing_configured: boolean;
      currency: string | null;
    }>;
  }>();

  // In-memory equivalent of the previous model_cards ⟕ channel_models ⟕ channels join.
  for (const card of cards) {
    const model = {
      id: card.id,
      unified_model_id: card.unified_model_id,
      display_name: card.display_name,
      status: card.status,
      instances: [] as Array<{
        id: string;
        channel_id: string;
        channel_name: string;
        provider_model_id: string;
        public_model_alias: string;
        sort_order: number;
        status: 'active' | 'disabled';
        channel_status: 'active' | 'disabled';
        pricing_configured: boolean;
        currency: string | null;
      }>,
    };
    modelMap.set(card.id, model);

    const instances = await listChannelModels(env.DB, card.id);
    for (const instance of instances) {
      const channel = channelById.get(instance.channel_id);
      if (!channel) continue; // channel missing/deleted — dropped by the old LEFT JOIN filter
      model.instances.push({
        id: instance.id,
        channel_id: instance.channel_id,
        channel_name: channel.name,
        provider_model_id: instance.channel_model_id,
        public_model_alias: instance.public_model_alias,
        sort_order: instance.sort_order ?? model.instances.length,
        status: instance.status,
        channel_status: channel.status,
        pricing_configured: instance.input_price_micros_per_million !== null
          || instance.output_price_micros_per_million !== null
          || instance.cache_input_price_micros_per_million !== null,
        currency: instance.currency,
      });
    }
  }

  const models = [...modelMap.values()];
  const readyModels = models.filter((model) => model.status === 'active'
    && model.instances.some((instance) => instance.status === 'active' && instance.channel_status === 'active'));
  const now = Math.floor(Date.now() / 1000);
  const keys = keyRows.map(toPublicKey);
  const activeKeys = keys.filter((key) => key.status === 'active'
    && (key.expires_at === null || key.expires_at > now));

  let setupState: SetupState = 'ready';
  if (channels.length === 0) setupState = 'needs_channel';
  else if (readyModels.length === 0) setupState = 'needs_model';
  else if (activeKeys.length === 0) setupState = 'needs_gateway_key';

  return jsonResponse({
    system: { version: env.APP_VERSION ?? '0.1.0', status: 'ok' },
    authorization: { permission },
    setup_state: setupState,
    ready_for_inference: setupState === 'ready',
    recommended_action: recommendedAction(setupState),
    channels: {
      total: channels.length,
      active: channels.filter((channel) => channel.status === 'active').length,
      disabled: channels.filter((channel) => channel.status === 'disabled').length,
      items: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        provider_type: channel.provider_type,
        preset_id: channel.preset_id,
        status: channel.status,
        protocols: channel.protocols.map((protocol) => protocol.protocol),
      })),
    },
    models: {
      total: models.length,
      ready: readyModels.length,
      unbound: models.filter((model) => model.instances.length === 0).length,
      items: models,
    },
    gateway_keys: {
      total: keys.length,
      active: activeKeys.length,
      disabled_or_expired: keys.length - activeKeys.length,
      items: keys.map((key) => ({
        id: key.id,
        name: key.name,
        status: key.status,
        expires_at: key.expires_at,
        model_allowlist: key.model_allowlist,
        is_temporary: key.is_temporary,
      })),
    },
    balances: cachedProviderBalances(channels),
  });
}
