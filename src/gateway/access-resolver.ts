import { TtlLruCache } from '../cache/ttl-lru.ts';
import { resolveRoute, type CandidateRow, type ResolvedRoute } from '../db/models.ts';
import { getGatewayKeyIdentityByHash } from '../db/keys.ts';
import type { LimitPeriod } from '../shared/key-limits.ts';

const ACTIVE_KEY_TTL_MS = 30_000;
const INACTIVE_KEY_TTL_MS = 5_000;
const RESOLVED_MODEL_TTL_MS = 60_000;
const UNRESOLVED_MODEL_TTL_MS = 5_000;

const keyCache = new TtlLruCache<string, CachedGatewayKey>(1_000);
const modelCache = new TtlLruCache<string, CachedModelResolution>(200);

export interface GatewayKeyIdentity {
  id: string;
  name: string;
  rpmLimit: number | null;
  requestLimit: number | null;
  tokenLimit: number | null;
  limitPeriod: LimitPeriod;
  expiresAt: number | null;
  modelAllowlist: string[];
}

export interface ResolvedModel {
  direct: boolean;
  candidates: CandidateRow[];
  unifiedModelId: string;
  modelCardId: string;
}

type CachedGatewayKey =
  | { active: true; identity: GatewayKeyIdentity }
  | { active: false };

export type ModelResolution =
  | { status: 'resolved'; value: ResolvedModel }
  | { status: 'not_found' }
  | { status: 'unavailable' };

type CachedModelResolution = ModelResolution;

export interface GatewayAccessMetrics {
  cacheStatus: 'hit' | 'partial' | 'miss';
  keyCache: 'hit' | 'miss';
  modelCache: 'hit' | 'miss' | 'skipped';
  /** Number of KV lookups performed on this call (kept name for log compatibility). */
  d1Statements: number;
  d1Ms: number;
  accessMs: number;
}

export interface GatewayAccessResult {
  key: GatewayKeyIdentity | null;
  model: ModelResolution;
  metrics: GatewayAccessMetrics;
}

function toModelResolution(modelName: string, route: ResolvedRoute | null): ModelResolution {
  if (!route) return { status: 'not_found' };

  if (route.identifier_type === 'alias') {
    const direct = route.candidates.find(
      (candidate) => candidate.channel_model_id_pk === route.direct_channel_model_id,
    );
    if (!direct) return { status: 'unavailable' };
    return {
      status: 'resolved',
      value: {
        direct: true,
        candidates: [direct],
        unifiedModelId: modelName,
        modelCardId: route.model_card_id,
      },
    };
  }

  if (route.candidates.length === 0) return { status: 'unavailable' };
  return {
    status: 'resolved',
    value: {
      direct: false,
      candidates: route.candidates,
      unifiedModelId: modelName,
      modelCardId: route.model_card_id,
    },
  };
}

function cacheKey(keyHash: string, value: CachedGatewayKey): void {
  keyCache.set(keyHash, value, value.active ? ACTIVE_KEY_TTL_MS : INACTIVE_KEY_TTL_MS);
}

function cacheModel(modelName: string, value: ModelResolution): void {
  modelCache.set(
    modelName,
    value,
    value.status === 'resolved' ? RESOLVED_MODEL_TTL_MS : UNRESOLVED_MODEL_TTL_MS,
  );
}

export async function authenticateGatewayKeyHash(
  db: KVNamespace,
  keyHash: string,
): Promise<GatewayKeyIdentity | null> {
  const cached = keyCache.get(keyHash);
  if (cached) return cached.active ? cached.identity : null;

  const identity = await getGatewayKeyIdentityByHash(db, keyHash);
  const resolved: CachedGatewayKey = identity ? { active: true, identity } : { active: false };
  cacheKey(keyHash, resolved);
  return identity;
}

/**
 * Resolve gateway authentication and model routing together. Both lookups run
 * in parallel on a full cache miss; partial misses only fetch the missing value.
 */
export async function resolveGatewayAccess(
  db: KVNamespace,
  keyHash: string,
  modelName: string,
): Promise<GatewayAccessResult> {
  const accessStartedAt = performance.now();
  const cachedKey = keyCache.get(keyHash);
  const cachedModel = modelCache.get(modelName);

  const metrics = (
    kvLookups: number,
    kvMs: number,
    modelCacheStatus: GatewayAccessMetrics['modelCache'] = cachedModel ? 'hit' : 'miss',
  ): GatewayAccessMetrics => {
    const modelSatisfiedWithoutKv = modelCacheStatus !== 'miss';
    return {
      cacheStatus: cachedKey && modelSatisfiedWithoutKv
        ? 'hit'
        : cachedKey || modelSatisfiedWithoutKv ? 'partial' : 'miss',
      keyCache: cachedKey ? 'hit' : 'miss',
      modelCache: modelCacheStatus,
      d1Statements: kvLookups,
      d1Ms: Math.round(kvMs * 100) / 100,
      accessMs: Math.round((performance.now() - accessStartedAt) * 100) / 100,
    };
  };

  if (cachedKey && !cachedKey.active) {
    return {
      key: null,
      model: cachedModel ?? { status: 'not_found' },
      metrics: metrics(0, 0, cachedModel ? 'hit' : 'skipped'),
    };
  }
  if (cachedKey && cachedModel) {
    return { key: cachedKey.identity, model: cachedModel, metrics: metrics(0, 0) };
  }

  let lookups = 0;
  const kvStartedAt = performance.now();
  const [keyIdentity, route] = await Promise.all([
    cachedKey ? Promise.resolve(null) : (lookups++, getGatewayKeyIdentityByHash(db, keyHash)),
    cachedModel ? Promise.resolve(null) : (lookups++, resolveRoute(db, modelName)),
  ]);
  const kvMs = performance.now() - kvStartedAt;

  const resolvedKey: CachedGatewayKey = cachedKey ?? (keyIdentity ? { active: true, identity: keyIdentity } : { active: false });
  if (!cachedKey) cacheKey(keyHash, resolvedKey);

  const resolvedModel = cachedModel ?? toModelResolution(modelName, route);
  // An invalid caller may supply arbitrary model names. Return the already
  // fetched result, but do not let unauthenticated traffic churn the route cache.
  if (!cachedModel && resolvedKey.active) cacheModel(modelName, resolvedModel);

  return {
    key: resolvedKey.active ? resolvedKey.identity : null,
    model: resolvedModel,
    metrics: metrics(lookups, kvMs),
  };
}

export function invalidateGatewayKeyCache(): void {
  keyCache.clear();
}

export function invalidateModelRouteCache(): void {
  modelCache.clear();
}

/** Test-only reset for module-level isolate state. */
export function resetGatewayAccessCaches(): void {
  keyCache.clear();
  modelCache.clear();
}
