/**
 * CORS support for the /v1/* gateway API.
 *
 * Browser-based clients send a preflight OPTIONS before a cross-origin POST.
 * Without an OPTIONS handler the preflight fails and the real gateway error
 * body becomes unreadable. CORS only relaxes the browser origin check — the
 * Gateway Key authentication middleware still runs for every non-preflight
 * request, so widening CORS does not weaken key validation.
 */

export const GATEWAY_CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';

/** Header allowlist covering OpenAI Bearer and Anthropic SDK request headers. */
export const GATEWAY_CORS_ALLOW_HEADERS =
  'Authorization, x-api-key, Content-Type, anthropic-version';

export const GATEWAY_CORS_MAX_AGE = '86400';

/**
 * Apply CORS response headers, echoing the request Origin when present so the
 * browser can read the response body (including error responses).
 */
export function applyGatewayCors(headers: Headers, origin: string | null): Headers {
  headers.set('Access-Control-Allow-Origin', origin ?? '*');
  if (origin) headers.append('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', GATEWAY_CORS_ALLOW_METHODS);
  headers.set('Access-Control-Allow-Headers', GATEWAY_CORS_ALLOW_HEADERS);
  return headers;
}

/**
 * Preflight response. It is returned before the auth middleware runs, so a
 * preflight (which never carries credentials) is not rejected with 401.
 */
export function gatewayPreflightResponse(origin: string | null): Response {
  const headers = applyGatewayCors(new Headers(), origin);
  headers.set('Access-Control-Max-Age', GATEWAY_CORS_MAX_AGE);
  return new Response(null, { status: 204, headers });
}
