/**
 * Platform-neutral ambient types for the EdgeOne Makers edge runtime.
 *
 * The Cloudflare `@cloudflare/workers-types` dependency was removed during the
 * EdgeOne Makers migration. These minimal interfaces cover the KV binding and
 * execution-context shapes the gateway code relies on; the EdgeOne Makers
 * runtime provides equivalent objects at deploy time.
 */

interface KVListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface KVListResult {
  keys: KVListKey[];
  list_complete: boolean;
  cursor?: string;
}

interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: 'text'): Promise<string | null>;
  get(key: string, type: 'json'): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVListOptions): Promise<KVListResult>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Per-request props bag expected by Hono's execution context type. */
  props: unknown;
  exports?: unknown;
}
