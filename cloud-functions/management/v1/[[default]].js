/**
 * EdgeOne Cloud Function entry for `/management/v1/*`.
 *
 * File path is the route (`cloud-functions/management/v1/[[default]].js` →
 * `/management/v1/*`, matching one or more segments). The platform registers
 * this as a multi-level catch-all because it exports a Handler; the handler
 * delegates to the shared gateway adapter.
 */
import { handleGatewayRequest } from '../../../src/platform/edgeone-entry.ts';

/** EdgeOne Cloud Function handler: `onRequest(context)` returns a `Response`. */
export function onRequest(context) {
  return handleGatewayRequest(context);
}
