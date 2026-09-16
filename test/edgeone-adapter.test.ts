import { describe, expect, test } from 'vitest';
import {
  MissingBindingError,
  bindingUnavailableResponse,
  buildPlatformEnv,
  createEdgeOneHandler,
  createMissingAssets,
  createMissingDatabase,
  isGatewayApiPath,
  toStandardRequest,
} from '../src/platform/edgeone.ts';

const asD1 = (value: unknown): D1Database => value as unknown as D1Database;

describe('isGatewayApiPath', () => {
  test('claims the documented API prefixes and the health check', () => {
    for (const path of [
      '/admin/api/session',
      '/v1/chat/completions',
      '/management/v1/capabilities',
      '/health',
    ]) {
      expect(isGatewayApiPath(path)).toBe(true);
    }
  });

  test('leaves static assets and SPA routes to the platform static host', () => {
    for (const path of [
      '/',
      '/index.html',
      '/assets/app.js',
      '/channels',
      '/analytics/usage',
      '/skill.json',
      '/healthz',
      '/v1',
    ]) {
      expect(isGatewayApiPath(path)).toBe(false);
    }
  });
});

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
  test('routes API paths through the gateway worker', async () => {
    const handler = createEdgeOneHandler({
      fetch: async (request) => new Response(`api:${new URL(request.url).pathname}`),
    });
    const response = await handler({ request: new Request('https://gw.example.com/v1/models') });
    expect(await response.text()).toBe('api:/v1/models');
  });

  test('defers non-API requests to the platform via next()', async () => {
    const handler = createEdgeOneHandler({
      fetch: async () => {
        throw new Error('gateway must not run for static requests');
      },
    });
    const response = await handler({
      request: new Request('https://gw.example.com/assets/app.js'),
      next: () => new Response('static', { status: 200 }),
    });
    expect(await response.text()).toBe('static');
  });

  test('stops a self-subrequest from looping back into the catch-all', async () => {
    const handler = createEdgeOneHandler({ fetch: async () => new Response('api') });
    const response = await handler({
      request: new Request('https://gw.example.com/channels', {
        headers: { 'x-mygateway-static-pass': '1' },
      }),
    });
    expect(response.status).toBe(404);
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

  test('forwards waitUntil and does not swallow the gateway response', async () => {
    const seen: Promise<unknown>[] = [];
    const handler = createEdgeOneHandler({
      fetch: async (_request, _env, ctx) => {
        ctx.waitUntil(Promise.resolve('stat'));
        return new Response('ok', { status: 200 });
      },
    });
    const response = await handler({
      request: new Request('https://gw.example.com/health'),
      waitUntil: (promise) => seen.push(promise),
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe('toStandardRequest', () => {
  test('returns a Request instance unchanged', () => {
    const request = new Request('https://gw.example.com/health');
    expect(toStandardRequest(request)).toBe(request);
  });
});
