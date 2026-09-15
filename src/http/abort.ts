/**
 * Timeout helpers built on pure Web standard APIs.
 *
 * The EdgeOne Makers edge runtime does not implement the `AbortSignal`
 * `timeout()` static method (calling it throws `TypeError`), so callers must
 * combine `AbortController` with `setTimeout` / `clearTimeout` instead.
 */

export interface TimeoutSignal {
  /** Signal passed to `fetch`; aborted once the timeout elapses. */
  signal: AbortSignal;
  /** Clears the pending timer; always call it once the request settles. */
  clear: () => void;
}

/**
 * Create an abort signal that fires after `ms` milliseconds.
 *
 * The returned `clear` must be invoked after the request settles (success or
 * failure) so the timer does not leak.
 */
export function createTimeoutSignal(ms: number): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/**
 * `fetch` wrapper that enforces a timeout via {@link createTimeoutSignal} and
 * guarantees the timer is cleared on both the success and failure paths.
 *
 * On timeout the underlying fetch rejects with an `AbortError`, matching the
 * native `AbortSignal` `timeout()` behavior.
 *
 * The timeout only covers receiving the response headers: once the `Response`
 * is returned the timer is already cleared, so callers that read the body must
 * hold their own signal for the duration of that read (see
 * `src/admin/model-discovery.ts`, which keeps the `createTimeoutSignal` signal
 * alive across the body read instead of using this helper).
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const { signal, clear } = createTimeoutSignal(ms);
  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clear();
  }
}

/**
 * True when `error` came from an aborted or timed-out fetch. The runtime rejects
 * with `AbortError` when a controller aborts; `TimeoutError` is accepted for
 * runtimes that surface it instead.
 */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
