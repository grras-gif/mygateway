/**
 * EdgeOne Makers Hono application.
 *
 * EdgeOne Makers detects Hono from the imported framework and then requires the
 * Cloud Function entry to (a) live at a `[[filename]]` path and (b) default-export
 * the framework app instance instead of a per-route `onRequest` handler.
 * `cloud-functions/[[default]].js` is the thin wrapper that does exactly that.
 *
 * A single catch-all app owns every API prefix the gateway serves; static files
 * and the SPA shell stay on the platform's static host and normally never reach
 * this function. Requests are dispatched to the same logic the Cloudflare Worker
 * uses (`src/index.ts`), so routing, auth and error semantics stay identical:
 *  - `GET /health`      → `{ status, version }`
 *  - `/v1/*`            → `src/gateway/hono.ts` `gatewayApp`
 *  - `/admin/api/*`     → `src/admin/router.ts` `handleAdminApi`
 *  - `/management/v1/*` → `src/management/router.ts` `handleManagementApi`
 *  - navigation paths   → SPA shell (`/index.html`) re-fetched from the host
 *  - anything else      → JSON `404`
 *
 * The platform has no D1 / Workers Assets binding, so `src/platform/edgeone.ts`
 * builds a Workers-shaped `Env` from the platform environment (`c.env`) and maps
 * a missing binding to `503` (any other failure to `500`).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.ts';
import { gatewayApp } from '../gateway/hono.ts';
import { handleAdminApi } from '../admin/router.ts';
import { handleManagementApi } from '../management/router.ts';
import { runWithPlatformEnv } from './edgeone.ts';

/** Platform bindings are opaque key/value pairs copied into the gateway `Env`. */
type PlatformBindings = Record<string, unknown>;
type AppContext = Context<{ Bindings: PlatformBindings }>;

export const app = new Hono<{ Bindings: PlatformBindings }>();

/** Host path of the SPA shell that deep navigation routes fall back to. */
const SPA_SHELL_PATH = '/index.html';

/**
 * A navigation request is a path whose final segment has no file extension.
 * `/login` and `/analytics/logs` qualify; `/assets/app.js` and `/index.html` do
 * not, which also keeps the shell path itself out of the fallback branch.
 */
export function isNavigationRequest(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.length > 0 && !lastSegment.includes('.');
}

/** Read the platform execution context; Hono throws when the runtime omits it. */
function executionContextOf(c: AppContext): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** Build the gateway `Env` from `c.env`, run the handler, normalize errors. */
function dispatch(
  c: AppContext,
  handler: (env: Env, ctx: ExecutionContext) => Promise<Response>,
): Promise<Response> {
  return runWithPlatformEnv(c.env, executionContextOf(c), handler);
}

// Health check — no auth, no database.
app.get('/health', (c) =>
  dispatch(c, async (env) => Response.json({ status: 'ok', version: env.APP_VERSION ?? '0.1.0' })),
);

// Gateway data plane (Hono + OpenAPI), including its own auth and CORS.
app.all('/v1/*', (c) => dispatch(c, (env, ctx) => gatewayApp.fetch(c.req.raw, env, ctx)));

// Admin API backing the management console.
app.all('/admin/api/*', (c) =>
  dispatch(c, (env) => handleAdminApi(c.req.raw, new URL(c.req.url), env)),
);

// Versioned Management API for scoped machine credentials.
app.all('/management/v1/*', (c) =>
  dispatch(c, (env, ctx) => handleManagementApi(c.req.raw, new URL(c.req.url), env, ctx)),
);

// Static files and the SPA shell are served by the platform. A non-API
// navigation path (for example `/login` or `/analytics/logs`) that reaches the
// function is a deep-route refresh, so re-fetch the SPA shell from the host and
// return it as HTML instead of a JSON 404. `/index.html` itself carries an
// extension and never enters this branch, so there is no self-recursion.
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (isNavigationRequest(url.pathname)) {
    const shellUrl = new URL(SPA_SHELL_PATH + url.search, url.origin);
    try {
      const shell = await fetch(shellUrl);
      if (shell.ok && (shell.headers.get('content-type') ?? '').includes('text/html')) {
        return new Response(shell.body, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    } catch {
      // Shell unavailable — fall through to the JSON 404 below.
    }
  }
  return Response.json(
    {
      error: {
        message: 'Not Found',
        type: 'gateway_error',
        param: null,
        code: 'not_found',
      },
    },
    { status: 404 },
  );
});

export default app;
