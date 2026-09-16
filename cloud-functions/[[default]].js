/**
 * EdgeOne Makers Cloud Function catch-all entry (`cloud-functions/[[default]].js`).
 *
 * File path is the route: `[[default]]` matches every request that is not a
 * static asset. The platform used to deploy this project as a pure static site
 * ("No server-handler detected"), so `/admin/api/*`, `/v1/*`,
 * `/management/v1/*` and `/health` were answered with `index.html` and the
 * console failed with `Unexpected token '<'`.
 *
 * This entry routes those API prefixes into the existing gateway worker
 * (`src/index.ts`) and lets every other request fall through to the static
 * host. Runtime differences (no D1 / no Assets binding on EdgeOne) are handled
 * by `src/platform/edgeone.ts`.
 */
import worker from '../src/index.ts';
import { createEdgeOneHandler } from '../src/platform/edgeone.ts';

const handle = createEdgeOneHandler(worker);

/** EdgeOne Cloud Function handler: `onRequest(context)` returns a `Response`. */
export function onRequest(context) {
  return handle(context);
}
