/**
 * EdgeOne Makers platform adapter.
 *
 * The gateway core (`src/index.ts`) targets the Cloudflare Workers runtime and
 * expects two bindings: `env.DB` (D1) and `env.ASSETS` (Workers Static Assets).
 * EdgeOne Makers instead runs the backend as a Node.js Cloud Function: the
 * request arrives on `context.request`, configuration/secrets come from
 * `context.env`, and neither D1 nor a Workers Assets binding exists.
 *
 * This adapter bridges the two runtimes without touching the gateway logic:
 *  - it decides which paths the gateway owns (see `isGatewayApiPath`);
 *  - it builds a Workers-shaped `Env` from the platform environment;
 *  - it substitutes explicit, safe fallbacks for the missing bindings so an
 *    unavailable database surfaces as a clear `503` instead of an HTML page or
 *    an opaque crash;
 *  - it defers every non-API request to the platform static host so real files
 *    and SPA rewrites are not shadowed.
 *
 * NOTE (migration): the D1/ASSETS fallbacks are a temporary degradation, not a
 * real backend. A production EdgeOne deployment must wire `env.DB` to an
 * actual database (platform KV/Blob plus an external SQL service, or D1 reached
 * over an HTTP API) and point `env.ASSETS` at the static host. Until then the
 * gateway's data-plane and admin APIs answer `503 binding_unavailable`.
 */

import type { Env } from '../env.ts';

/** Path prefixes the gateway core owns. Mirrors `wrangler.jsonc` run_worker_first. */
export const GATEWAY_API_PREFIXES = ['/admin/api/', '/v1/', '/management/v1/'] as const;

/** Exact health-check path (no auth, no database). */
export const GATEWAY_HEALTH_PATH = '/health';

/**
 * True when the path must be handled by the gateway. Everything else (static
 * files, the SPA shell, `robots.txt`, ...) belongs to the platform static host.
 */
export function isGatewayApiPath(pathname: string): boolean {
  if (pathname === GATEWAY_HEALTH_PATH) return true;
  return GATEWAY_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Error raised when the gateway touches a binding this runtime cannot provide. */
export class MissingBindingError extends Error {
  readonly binding: string;

  constructor(binding: string, hint: string) {
    super(`Binding "${binding}" is unavailable in this runtime. ${hint}`);
    this.name = 'MissingBindingError';
    this.binding = binding;
  }
}

const DATABASE_HINT =
  'EdgeOne Makers has no D1 binding. Wire env.DB to a real database ' +
  '(platform KV/Blob with an external SQL service, or D1 over an HTTP API) before serving data-plane traffic.';

/**
 * A D1-shaped stub that throws `MissingBindingError` the first time it is used.
 * Returning a value (instead of `undefined`) keeps existing `if (env.DB)` guards
 * working while still failing loudly and in one place.
 */
export function createMissingDatabase(): D1Database {
  const fail = (): never => {
    throw new MissingBindingError('DB', DATABASE_HINT);
  };
  return new Proxy({} as D1Database, {
    get(_target, property) {
      // Keep the stub non-thenable and safe to inspect/log.
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return fail;
    },
  });
}

/** A Fetcher-shaped stub that reports every asset as missing (404). */
export function createMissingAssets(): Fetcher {
  return {
    async fetch(): Promise<Response> {
      return new Response('Not Found', { status: 404 });
    },
  } as unknown as Fetcher;
}

/**
 * Config keys the gateway reads from `Env`. Secrets stay server-side: they are
 * copied from `context.env` only, never hardcoded or logged.
 */
const CONFIG_KEYS = [
  'INITIAL_ADMIN_USERNAME',
  'INITIAL_ADMIN_PASSWORD',
  'ADMIN_TOKEN',
  'MASTER_KEY',
  'APP_VERSION',
  'DEFAULT_TIMEZONE',
  'MAX_REQUEST_BYTES',
  'MAX_CHANNEL_ATTEMPTS',
  'UPSTREAM_HEADER_TIMEOUT_MS',
  'USAGE_RETENTION_DAYS',
  'KEY_QUOTA_REFRESH_MS',
] as const;

function hasFunction(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === 'function'
  );
}

/**
 * Build a Workers-shaped `Env` from the platform environment.
 *
 * Known string variables are copied across. `DB` and `ASSETS` are passed
 * through when the platform actually binds them, and otherwise replaced with
 * safe fallbacks so the gateway can start and answer with a clear error instead
 * of crashing on the first database access.
 */
export function buildPlatformEnv(source: Record<string, unknown> | undefined): Env {
  const platformEnv = source ?? {};
  const adapted: Record<string, unknown> = {};

  for (const key of CONFIG_KEYS) {
    const value = platformEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      adapted[key] = value;
    }
  }

  // MASTER_KEY is required by parseConfig(); surface an empty value so the
  // gateway returns its own config_error instead of `undefined`.
  if (typeof adapted.MASTER_KEY !== 'string') adapted.MASTER_KEY = '';

  adapted.DB = hasFunction(platformEnv.DB, 'prepare') ? platformEnv.DB : createMissingDatabase();
  adapted.ASSETS = hasFunction(platformEnv.ASSETS, 'fetch') ? platformEnv.ASSETS : createMissingAssets();

  return adapted as unknown as Env;
}

/** Gateway-shaped `503` body for a missing binding. */
export function bindingUnavailableResponse(error: MissingBindingError): Response {
  return Response.json(
    {
      error: {
        message: error.message,
        type: 'gateway_error',
        param: null,
        code: 'binding_unavailable',
      },
    },
    { status: 503 },
  );
}

/** Generic `500` body for unexpected failures inside the gateway. */
function internalErrorResponse(error: unknown): Response {
  return Response.json(
    {
      error: {
        message: `Gateway handler failed: ${error instanceof Error ? error.message : String(error)}`,
        type: 'gateway_error',
        param: null,
        code: 'gateway_internal_error',
      },
    },
    { status: 500 },
  );
}

/** Minimal view of the EdgeOne Cloud Function `context`. */
export interface PlatformContext {
  request: Request;
  env?: Record<string, unknown>;
  /** EdgeOne hook to hand the request back to the platform static host. */
  next?: () => Promise<Response> | Response;
  /** EdgeOne hook to keep background work alive after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The gateway entry contract (`src/index.ts` default export). */
export interface GatewayWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/** Header used to detect a self-subrequest while deferring to the static host. */
const PASS_THROUGH_HEADER = 'x-mygateway-static-pass';

/** Adapt the platform request into a standard `Request` the gateway can read. */
export function toStandardRequest(request: Request): Request {
  return request instanceof Request ? request : new Request(request);
}

/**
 * Build an `ExecutionContext` for the gateway. `waitUntil` is forwarded to the
 * platform when available and otherwise drained so background statistics never
 * turn into unhandled rejections (and never delay the response).
 */
function createExecutionContext(waitUntil?: (promise: Promise<unknown>) => void): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>): void {
      if (typeof waitUntil === 'function') {
        waitUntil(promise);
        return;
      }
      Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException(): void {},
    props: {},
  } as unknown as ExecutionContext;
}

/**
 * Defer a non-API request to the platform static host so real files and the SPA
 * rewrites keep working. Prefers EdgeOne's `next()`; without it, re-fetches the
 * same URL with a guard header that stops a self-subrequest from looping back
 * into this catch-all.
 */
async function passToStaticHost(context: PlatformContext, request: Request): Promise<Response> {
  if (typeof context.next === 'function') {
    return await context.next();
  }

  if (request.headers.get(PASS_THROUGH_HEADER)) {
    // We re-entered our own catch-all; stop instead of looping.
    return new Response('Not Found', { status: 404 });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const headers = new Headers(request.headers);
  headers.set(PASS_THROUGH_HEADER, '1');
  try {
    return await fetch(new Request(request.url, { method: request.method, headers }));
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Wrap the gateway worker into an EdgeOne Cloud Function `onRequest` handler.
 * API paths run through the gateway; everything else is deferred to the static
 * host so static files and SPA routes are never shadowed by HTML.
 */
export function createEdgeOneHandler(worker: GatewayWorker) {
  return async function onRequest(context: PlatformContext): Promise<Response> {
    const request = toStandardRequest(context.request);
    const { pathname } = new URL(request.url);

    if (!isGatewayApiPath(pathname)) {
      return passToStaticHost(context, request);
    }

    const env = buildPlatformEnv(context.env);
    const ctx = createExecutionContext(context.waitUntil);

    try {
      return await worker.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof MissingBindingError) {
        return bindingUnavailableResponse(error);
      }
      return internalErrorResponse(error);
    }
  };
}
