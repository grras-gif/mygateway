/**
 * EdgeOne Makers edge function entry (catch-all).
 *
 * Adapts the EdgeOne `context` object into the `(request, env, ctx)` shape the
 * business router expects, then hands unmatched paths back to the platform via
 * `context.next()` so `dashboard/dist` static assets (the console) are served
 * unchanged.
 *
 * Only `/health`, `/v1/*`, `/admin/api/*` and `/management/v1/*` are claimed by
 * the backend; every other path falls through to static assets.
 */

import { Env } from '../src/env.ts';
import { handleRequest } from '../src/index.ts';
import { ensureBootstrapData } from '../src/db/bootstrap.ts';

/** Subset of the EdgeOne Makers context used by this entry. */
interface EdgeOneContext {
  request: Request;
  params?: Record<string, string | string[]>;
  env: Env;
  waitUntil?(promise: Promise<unknown>): void;
  next?(request?: Request): Response | Promise<Response>;
}

/** Minimal ExecutionContext adapter for the business router. */
function toExecutionContext(context: EdgeOneContext): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>): void {
      if (typeof context.waitUntil === 'function') context.waitUntil(promise);
    },
    passThroughOnException(): void {
      // No platform equivalent; usage writes already fail safe inside the router.
    },
    props: {},
  };
}

export async function onRequest(context: EdgeOneContext): Promise<Response> {
  const { request, env } = context;

  // Idempotent baseline seed (settings + model prices). Best-effort: a failure
  // only records `kv_seed_failed` and never affects the returned response.
  const seed = ensureBootstrapData(env.DB).catch((error: unknown) => {
    console.error('kv_seed_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (typeof context.waitUntil === 'function') {
    context.waitUntil(seed);
  } else {
    await seed;
  }

  const response = await handleRequest(request, env, toExecutionContext(context));
  if (response) return response;

  // Not a backend route → let the platform serve static assets.
  if (typeof context.next === 'function') return context.next();
  return new Response('Not Found', { status: 404 });
}
