/**
 * EdgeOne Makers Cloud Function entry (Hono framework mode).
 *
 * EdgeOne detects Hono from the imported framework and therefore requires this
 * entry to use the `[[filename]]` naming and to default-export the framework app
 * instance — not a per-route `onRequest` handler. The app itself lives in
 * `src/platform/edgeone-app.ts` so it stays TypeScript and unit-testable; this
 * file is only the thin entry the platform loads and bundles.
 */
import app from '../src/platform/edgeone-app.ts';

export default app;
