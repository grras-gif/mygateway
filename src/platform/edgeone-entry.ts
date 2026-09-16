/**
 * Shared EdgeOne Cloud Function entry: the gateway worker wrapped in the
 * platform adapter (`src/platform/edgeone.ts`).
 *
 * The `cloud-functions/` file tree owns routing (one entry per API prefix).
 * This module only exposes the constructed handler so each entry file stays a
 * thin, single-export wrapper. It intentionally exports no `onRequest*` handler
 * of its own, so it is never registered as a route.
 */

import worker from '../index.ts';
import { createEdgeOneHandler } from './edgeone.ts';

export const handleGatewayRequest = createEdgeOneHandler(worker);
