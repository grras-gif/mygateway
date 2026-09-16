import { describe, expect, test } from 'vitest';
import { isNavigationRequest, serveStaticAsset } from '../src/http/static-assets.ts';

const SHELL = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';

class FakeAssets {
  readonly requestedPaths: string[] = [];

  constructor(private readonly files: Record<string, string>) {}

  async fetch(input: Request | string): Promise<Response> {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.url);
    this.requestedPaths.push(url.pathname);
    const body = this.files[url.pathname];
    if (body === undefined) return new Response('Not Found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
}

/** Throws for every path except the SPA shell, simulating a flaky asset layer. */
class ShellOnlyAssets {
  async fetch(input: Request | string): Promise<Response> {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.url);
    if (url.pathname === '/index.html') {
      return new Response(SHELL, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    throw new Error('asset fetch failed');
  }
}

class ThrowingAssets {
  async fetch(): Promise<Response> {
    throw new Error('asset fetch failed');
  }
}

const asFetcher = (value: unknown): Fetcher => value as unknown as Fetcher;

function assets(extra: Record<string, string> = {}): FakeAssets {
  return new FakeAssets({
    '/index.html': SHELL,
    '/assets/app.js': 'console.log(1);',
    '/logo.png': 'PNG',
    ...extra,
  });
}

describe('isNavigationRequest', () => {
  test('treats extension-less paths as navigation requests', () => {
    expect(isNavigationRequest('/channels')).toBe(true);
    expect(isNavigationRequest('/analytics/usage')).toBe(true);
    expect(isNavigationRequest('/change-password')).toBe(true);
  });

  test('treats paths with a file extension as concrete assets', () => {
    expect(isNavigationRequest('/assets/app.js')).toBe(false);
    expect(isNavigationRequest('/logo.png')).toBe(false);
    expect(isNavigationRequest('/skill.md')).toBe(false);
  });
});

describe('SPA static asset fallback', () => {
  test('serves the SPA shell for a missing deep route', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/analytics/usage'),
      asFetcher(assets()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(SHELL);
  });

  test('preserves 404 for a missing concrete asset', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/assets/missing.js'),
      asFetcher(assets()),
    );

    expect(response.status).toBe(404);
  });

  test('returns an existing asset unchanged', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/assets/app.js'),
      asFetcher(assets()),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1);');
  });

  test('falls back to the shell when the asset fetch throws for a navigation request', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/channels'),
      asFetcher(new ShellOnlyAssets()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(SHELL);
  });

  test('does not fall back when the asset fetch throws for a concrete asset', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/logo.png'),
      asFetcher(new ShellOnlyAssets()),
    );

    expect(response.status).toBe(404);
  });

  test('returns 404 when both the asset and the shell fetch fail', async () => {
    const response = await serveStaticAsset(
      new Request('https://gw.example.com/channels'),
      asFetcher(new ThrowingAssets()),
    );

    expect(response.status).toBe(404);
  });
});
