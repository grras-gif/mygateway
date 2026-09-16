/**
 * EdgeOne Cloud Function entry for `/health`.
 *
 * File path is the route (`cloud-functions/health.js` → `/health`). The
 * handler delegates to the shared gateway adapter; health needs no auth and no
 * database, so it never touches a missing binding.
 */
import { handleGatewayRequest } from '../src/platform/edgeone-entry.ts';

/** EdgeOne Cloud Function handler: `onRequest(context)` returns a `Response`. */
export function onRequest(context) {
  return handleGatewayRequest(context);
}
