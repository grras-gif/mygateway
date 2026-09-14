/**
 * MyGateway — EdgeOne Makers edge function
 * Request router shared by the edge function entry (`functions/[[default]].ts`).
 *
 * The entry adapts the EdgeOne `context` into `(request, env, ctx)` and calls
 * `handleRequest`. Returning `undefined` means "not a backend route" so the
 * caller can hand off to platform-served static assets (`context.next()`).
 */

import { Env, parseConfig, ConfigError } from './env.ts';
import { jsonResponse } from './http/json-response.ts';
import { generateRequestId } from './http/request-id.ts';
import { gatewayErrorResponse } from './http/errors.ts';
import { logConfigError } from './shared/log.ts';
import { handleAdminApi } from './admin/router.ts';
import { handleGatewayHono } from './gateway/hono.ts';
import { handleManagementApi } from './management/router.ts';

/** Route prefixes owned by the backend; everything else → static assets. */
const API_PREFIXES = ['/v1/', '/admin/api/', '/management/v1/'];

/** True when the path is served by the backend rather than static assets. */
export function isBackendRoute(pathname: string): boolean {
  return pathname === '/health' || API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Route a request to the backend. Returns `undefined` when the path is not a
 * backend route so the edge function can fall through to static assets.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;

  // --- Health check (no auth) ---
  if (path === '/health') {
    return jsonResponse({
      status: 'ok',
      version: env.APP_VERSION ?? '0.1.0',
    });
  }

  // Not a backend route → let the edge function serve static assets.
  if (!isBackendRoute(path)) {
    return undefined;
  }

  // --- Validate config ---
  try {
    parseConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      logConfigError(e.message);
      return gatewayErrorResponse(
        'config_error',
        'Server configuration error. Check environment variables.',
        generateRequestId(),
      );
    }
    throw e;
  }

  // --- Gateway API (Hono + OpenAPI) ---
  if (path.startsWith('/v1/')) {
    const gatewayResponse = await handleGatewayHono(request, env, ctx);
    if (gatewayResponse) {
      return gatewayResponse;
    }
    // Hono returned 404 (unknown /v1/* route) — fall through to a proper error
    const requestId = generateRequestId();
    return gatewayErrorResponse('invalid_request', 'Gateway route not found', requestId);
  }

  // --- Admin API ---
  if (path.startsWith('/admin/api/')) {
    return handleAdminApi(request, url, env);
  }

  // --- Versioned Management API for scoped machine credentials ---
  return handleManagementApi(request, url, env, ctx);
}
