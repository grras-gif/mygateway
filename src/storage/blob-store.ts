/**
 * EdgeOne Makers Blob storage adapter.
 *
 * The EdgeOne Makers runtime does not inject a storage binding into
 * `context.env`; persistent data is reached through the official
 * `@edgeone/pages-blob` SDK instead. This module wraps the SDK `Store` in the
 * platform-neutral `BlobStore` shape (`src/globals.d.ts`) that `src/kv/store.ts`
 * and every domain module already depend on, so those modules need no changes.
 *
 * The namespace is created automatically on first use and the SDK is
 * authenticated by the runtime, so no projectId / token is required here.
 */

import { getStore, type Store } from '@edgeone/pages-blob';

/** Blob namespace. Created automatically on first access. */
const NAMESPACE = 'mygateway';

/**
 * Read consistency.
 *
 * The gateway performs read-modify-write accumulation (`kvUpdateJson`) and
 * write-then-immediately-read flows (e.g. bootstrap seeding, key creation), so
 * reads must observe the most recent write. `strong` reads use the no-cache
 * domain; writes always target it regardless of this setting.
 */
const CONSISTENCY = 'strong' as const;

let cached: BlobStore | null = null;

/** Build the SDK-backed adapter. Throws a descriptive error on SDK failure. */
function createBlobStore(): BlobStore {
  let store: Store;
  try {
    store = getStore(NAMESPACE);
  } catch (error) {
    throw new Error(
      `Failed to initialise EdgeOne Makers Blob store "${NAMESPACE}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    async get(key: string): Promise<string | null> {
      return store.get(key, { type: 'text', consistency: CONSISTENCY });
    },
    async put(key: string, value: string): Promise<void> {
      await store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      await store.delete(key);
    },
    async list(options?: BlobListOptions): Promise<BlobListResult> {
      const result = await store.list({ prefix: options?.prefix, consistency: CONSISTENCY });
      return { objects: result.blobs.map((blob) => ({ key: blob.key })) };
    },
  };
}

/**
 * Return the shared BlobStore adapter.
 *
 * The underlying SDK store is created lazily on first use and reused for the
 * lifetime of the isolate. Creation failures propagate as clear errors rather
 * than being swallowed.
 */
export function getBlobStore(): BlobStore {
  if (!cached) cached = createBlobStore();
  return cached;
}
