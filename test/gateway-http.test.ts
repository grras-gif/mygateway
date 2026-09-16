import { describe, expect, test } from 'vitest';
import { gatewayApp } from '../src/gateway/hono.ts';
import { applyGatewayCors, gatewayPreflightResponse } from '../src/http/cors.ts';
import { invalidJsonBodyMessage } from '../src/gateway/chat-completions.ts';

const env = {} as never;
const ctx = {} as unknown as ExecutionContext;

function call(request: Request): Promise<Response> {
  return gatewayApp.fetch(request, env, ctx);
}

describe('gateway CORS preflight', () => {
  test('answers OPTIONS with 204 and CORS headers without requiring a key', async () => {
    const response = await call(new Request('https://gw.example.com/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://console.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://console.example.com');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');

    const allowHeaders = (response.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    for (const header of ['authorization', 'x-api-key', 'content-type', 'anthropic-version']) {
      expect(allowHeaders).toContain(header);
    }
  });

  test('adds CORS headers to error responses so the browser can read the body', async () => {
    const response = await call(new Request('https://gw.example.com/v1/models', {
      headers: { Origin: 'https://console.example.com' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://console.example.com');
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  test('uses a wildcard origin when the request carries no Origin header', async () => {
    const response = await call(new Request('https://gw.example.com/v1/models'));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('CORS helpers', () => {
  test('applyGatewayCors echoes the origin and sets Vary', () => {
    const headers = applyGatewayCors(new Headers(), 'https://console.example.com');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://console.example.com');
    expect(headers.get('Vary')).toBe('Origin');
  });

  test('gatewayPreflightResponse falls back to wildcard without an origin', () => {
    const response = gatewayPreflightResponse(null);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('invalid JSON body message', () => {
  test('explains an empty body and how to fix it', () => {
    for (const bodyText of ['', '   ', null]) {
      const message = invalidJsonBodyMessage(bodyText);
      expect(message.toLowerCase()).toContain('empty');
      expect(message).toContain('Content-Type: application/json');
    }
  });

  test('explains a malformed or non-object body', () => {
    for (const bodyText of ['{bad json', '[1,2,3]', '"just a string"']) {
      expect(invalidJsonBodyMessage(bodyText)).toContain('valid JSON object');
    }
  });
});
