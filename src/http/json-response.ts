/**
 * JSON response helper.
 *
 * The EdgeOne Makers edge runtime does not implement the static
 * `Response.json()` helper (calling it aborts the request with a 545). This
 * helper builds an equivalent `Response` from a JSON-serialized body so every
 * handler can keep returning JSON with explicit status codes and headers.
 */

/** Serialize `data` to JSON and return a `Response` with a JSON content type. */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}
