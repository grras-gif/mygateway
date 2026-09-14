/**
 * Platform-neutral ambient types for the EdgeOne Makers edge runtime.
 *
 * Persistent data lives in EdgeOne Makers Blob storage (object storage) instead
 * of the previous Cloudflare KV namespace. Object storage has no ordered/cursor
 * pagination, no atomic read-modify-write, and no prefix batch delete, so
 * `src/kv/store.ts` adapts those semantics on top of this minimal binding shape.
 * The EdgeOne Makers runtime provides an equivalent object at deploy time.
 */

/** One stored object returned by a Blob store listing. */
interface BlobObjectInfo {
  /** Full object path — the logical key mapped to a path in `src/kv/keys.ts`. */
  key: string;
  size?: number;
  uploadedAt?: number;
}

interface BlobListResult {
  /** Objects under the requested prefix, in store-defined (unsorted) order. */
  objects: BlobObjectInfo[];
}

interface BlobListOptions {
  /** Object-path prefix (directory prefix) to filter the listing by. */
  prefix?: string;
}

/**
 * EdgeOne Makers Blob storage binding.
 *
 * Object-storage semantics:
 * - `get`/`put` operate on a single object's text body;
 * - `delete` removes a single object (no prefix / batch delete);
 * - `list` returns every object under a prefix with no ordering guarantee and
 *   no cursor pagination.
 */
interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: BlobListOptions): Promise<BlobListResult>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Per-request props bag expected by Hono's execution context type. */
  props: unknown;
  exports?: unknown;
}
