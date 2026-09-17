import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  MissingBindingError,
  bindingUnavailableResponse,
  buildPlatformEnv,
  createEdgeOneHandler,
  createMissingAssets,
  createMissingDatabase,
  internalErrorResponse,
  runWithPlatformEnv,
  toStandardRequest,
} from '../src/platform/edgeone.ts';
import { app, isNavigationRequest } from '../src/platform/edgeone-app.ts';
import { createAdminSession } from '../src/auth/admin-session.ts';

const SHELL = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';

const asD1 = (value: unknown): D1Database => value as unknown as D1Database;

describe('missing binding fallbacks', () => {
  test('throws a located MissingBindingError when the database is used', () => {
    const db = createMissingDatabase();
    expect(() => db.prepare('select 1')).toThrow(MissingBindingError);
    expect(() => db.batch([])).toThrow(/DB/);
    // Non-thenable so awaiting it never hangs.
    expect((db as unknown as { then?: unknown }).then).toBeUndefined();
  });

  test('reports every asset as missing instead of crashing', async () => {
    const response = await createMissingAssets().fetch('https://gw.example.com/index.html');
    expect(response.status).toBe(404);
  });

  test('bindingUnavailableResponse returns a gateway-shaped 503', async () => {
    const response = bindingUnavailableResponse(new MissingBindingError('DB', 'no database'));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('binding_unavailable');
    expect(body.error.message).toContain('no database');
  });
});

describe('buildPlatformEnv', () => {
  test('copies known string config from the platform environment', () => {
    const env = buildPlatformEnv({ APP_VERSION: '9.9.9', MASTER_KEY: 'abc', MAX_REQUEST_BYTES: '1024' });
    expect(env.APP_VERSION).toBe('9.9.9');
    expect(env.MASTER_KEY).toBe('abc');
    expect(env.MAX_REQUEST_BYTES).toBe('1024');
  });

  test('substitutes safe fallbacks when DB/ASSETS are not bound', () => {
    const env = buildPlatformEnv({ MASTER_KEY: 'abc' });
    expect(env.MASTER_KEY).toBe('abc');
    expect(() => env.DB.prepare('select 1')).toThrow(MissingBindingError);
    expect(env.ASSETS).toBeTruthy();
  });

  test('passes through real bindings when the platform provides them', () => {
    const db = asD1({ prepare: () => 'statement' });
    const assets = { fetch: async () => new Response('ok') } as unknown as Fetcher;
    const env = buildPlatformEnv({ DB: db, ASSETS: assets });
    expect(env.DB).toBe(db);
    expect(env.ASSETS).toBe(assets);
    expect(env.MASTER_KEY).toBe('');
  });

  test('tolerates a missing platform environment object', () => {
    const env = buildPlatformEnv(undefined);
    expect(env.MASTER_KEY).toBe('');
    expect(env.DB).toBeTruthy();
  });
});

describe('createEdgeOneHandler', () => {
  test('runs every request the platform routed here through the gateway worker', async () => {
    const handler = createEdgeOneHandler({
      fetch: async (request) => new Response(`api:${new URL(request.url).pathname}`),
    });
    const response = await handler({ request: new Request('https://gw.example.com/v1/models') });
    expect(await response.text()).toBe('api:/v1/models');
  });

  test('builds a Workers-shaped Env from the platform environment', async () => {
    const handler = createEdgeOneHandler({
      fetch: async (_request, env) => new Response(env.APP_VERSION ?? 'missing'),
    });
    const response = await handler({
      request: new Request('https://gw.example.com/health'),
      env: { APP_VERSION: '9.9.9' },
    });
    expect(await response.text()).toBe('9.9.9');
  });

  test('converts a missing binding into a clear 503', async () => {
    const handler = createEdgeOneHandler({
      fetch: async (_request, env) => {
        env.DB.prepare('select 1');
        return new Response('unreachable');
      },
    });
    const response = await handler({
      request: new Request('https://gw.example.com/admin/api/session'),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('binding_unavailable');
  });

  test('converts an unexpected gateway failure into a 500', async () => {
    const handler = createEdgeOneHandler({
      fetch: async () => {
        throw new Error('boom');
      },
    });
    const response = await handler({ request: new Request('https://gw.example.com/health') });
    expect(response.status).toBe(500);
  });

  test('drains background work without delaying the gateway response', async () => {
    const handler = createEdgeOneHandler({
      fetch: async (_request, _env, ctx) => {
        ctx.waitUntil(Promise.reject(new Error('statistics failed')));
        return new Response('ok', { status: 200 });
      },
    });
    const response = await handler({ request: new Request('https://gw.example.com/health') });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});

describe('runWithPlatformEnv', () => {
  test('builds the Env and hands the handler a usable execution context', async () => {
    const response = await runWithPlatformEnv({ APP_VERSION: '9.9.9' }, undefined, async (env, ctx) => {
      ctx.waitUntil(Promise.reject(new Error('statistics failed')));
      return new Response(env.APP_VERSION ?? 'missing');
    });
    expect(await response.text()).toBe('9.9.9');
  });

  test('maps a missing binding to a 503 and other failures to a 500', async () => {
    const missing = await runWithPlatformEnv(undefined, undefined, async (env) => {
      env.DB.prepare('select 1');
      return new Response('unreachable');
    });
    expect(missing.status).toBe(503);

    const crashed = await runWithPlatformEnv(undefined, undefined, async () => {
      throw new Error('boom');
    });
    expect(crashed.status).toBe(500);
    const body = (await crashed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('gateway_internal_error');
  });

  test('internalErrorResponse is a gateway-shaped 500', async () => {
    const response = internalErrorResponse(new Error('boom'));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gateway_internal_error');
    expect(body.error.message).toContain('boom');
  });
});

describe('edgeone Hono app', () => {
  const call = (path: string, init?: RequestInit, env: Record<string, unknown> = {}) =>
    app.fetch(new Request(`https://gw.example.com${path}`, init), env);

  // The platform host serves the SPA shell over global `fetch`; each case
  // replaces it and this guard restores the original afterwards. The default
  // rejects so unknown-path cases stay deterministic without real networking.
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('answers /health with status and version from the platform env', async () => {
    const response = await call('/health', undefined, { APP_VERSION: '9.9.9' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: '9.9.9' });
  });

  test('falls back to the default version when APP_VERSION is absent', async () => {
    const response = await call('/health');
    expect(await response.json()).toEqual({ status: 'ok', version: '0.1.0' });
  });

  test('returns a JSON 404 for paths outside the API prefixes', async () => {
    const response = await call('/not-an-api');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  test('classifies navigation paths by a missing file extension', () => {
    expect(isNavigationRequest('/login')).toBe(true);
    expect(isNavigationRequest('/analytics/logs')).toBe(true);
    expect(isNavigationRequest('/missing.js')).toBe(false);
    expect(isNavigationRequest('/index.html')).toBe(false);
  });

  test('serves the SPA shell for a navigation path when the host returns HTML', async () => {
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(new URL(url).pathname).toBe('/index.html');
      return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof globalThis.fetch;

    const response = await call('/login');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(SHELL);
  });

  test('keeps a JSON 404 for a non-navigation unknown path', async () => {
    const response = await call('/missing.js');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  test('falls back to a JSON 404 when the shell fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof globalThis.fetch;

    const response = await call('/system');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  test('rejects /v1/* without a key before touching the missing database', async () => {
    const response = await call('/v1/models');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  test('maps a missing D1 binding to a clear 503', async () => {
    const response = await call('/v1/models', {
      headers: { authorization: 'Bearer gw_0123456789abcdef0123456789abcdef' },
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('binding_unavailable');
  });

  test('rejects admin login without a database when no bootstrap credentials are configured', async () => {
    const response = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  test('returns a 400 invalid_request for a malformed login body', async () => {
    const response = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('logs in with the configured credentials when no database is bound', async () => {
    const response = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    }, {
      MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      INITIAL_ADMIN_USERNAME: 'admin',
      INITIAL_ADMIN_PASSWORD: 'secret',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('mg_admin_session=');
  });

  test('rejects a wrong password without a database', async () => {
    const response = await call('/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    }, {
      MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      INITIAL_ADMIN_USERNAME: 'admin',
      INITIAL_ADMIN_PASSWORD: 'secret',
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  // The platform rewrites `Host` to an internal host while proxying, so a
  // same-origin browser write must still pass the CSRF check when
  // `X-Forwarded-Host` carries the public domain.
  test('accepts a same-origin mutation when the platform rewrote Host', async () => {
    const masterKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const setCookie = await createAdminSession(masterKey, {
      id: 'local-admin',
      username: 'admin',
      must_change_password: 0,
      session_version: 1,
    }, false);
    const cookie = setCookie.split(';')[0];

    const response = await call('/admin/api/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://public.example.com',
        host: 'internal.example.com',
        'x-forwarded-host': 'public.example.com',
      },
      // A body that passes model validation, so the request reaches the data
      // plane and the only remaining failure is the missing D1 binding.
      body: JSON.stringify({ unified_model_id: 'edgeone-model', display_name: 'EdgeOne Model' }),
    }, { MASTER_KEY: masterKey });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('binding_unavailable');
  });

  test('rejects a mutation from a genuinely cross-site origin', async () => {
    const masterKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const setCookie = await createAdminSession(masterKey, {
      id: 'local-admin',
      username: 'admin',
      must_change_password: 0,
      session_version: 1,
    }, false);
    const cookie = setCookie.split(';')[0];

    const response = await call('/admin/api/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example.com',
        host: 'internal.example.com',
        'x-forwarded-host': 'public.example.com',
      },
      body: '{}',
    }, { MASTER_KEY: masterKey });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('Cross-origin request denied');
  });
});

describe('toStandardRequest', () => {
  test('returns a Request instance unchanged', () => {
    const request = new Request('https://gw.example.com/health');
    expect(toStandardRequest(request)).toBe(request);
  });
});
