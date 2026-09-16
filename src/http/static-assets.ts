/**
 * Static asset serving for the management dashboard, with SPA fallback.
 *
 * The SolidJS console owns deep client routes (/channels, /analytics/usage,
 * ...) that the static host does not know about. EdgeOne hosting (unlike
 * Cloudflare's `not_found_handling: "single-page-application"`) does not
 * rewrite unknown paths to the SPA shell, so refreshing such a route would
 * return 404. Navigation requests that miss are answered with index.html,
 * while missing concrete assets keep their real 404 so broken files are not
 * silently masked as HTML.
 */

const SPA_SHELL_PATH = '/index.html';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * A navigation request is a path whose final segment has no file extension.
 * `/channels` and `/analytics/usage` qualify; `/assets/app.js` and `/logo.png`
 * do not.
 */
export function isNavigationRequest(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.length > 0 && !lastSegment.includes('.');
}

/** Fetch and return the SPA shell, or null when it is unavailable. */
async function fetchSpaShell(request: Request, assets: Fetcher): Promise<Response | null> {
  try {
    const shellUrl = new URL(SPA_SHELL_PATH, request.url);
    const shellResponse = await assets.fetch(new Request(shellUrl.toString(), { method: 'GET' }));
    if (!shellResponse.ok) return null;
    return new Response(request.method === 'HEAD' ? null : shellResponse.body, {
      status: 200,
      headers: { 'Content-Type': HTML_CONTENT_TYPE },
    });
  } catch {
    return null;
  }
}

/**
 * Serve a static asset. When the asset is missing (404 or a fetch error) and
 * the request is a navigation request, fall back to the SPA shell so deep
 * routes survive a full-page refresh.
 */
export async function serveStaticAsset(request: Request, assets: Fetcher): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  let response: Response;
  try {
    response = await assets.fetch(request);
  } catch {
    response = new Response('Not Found', { status: 404 });
  }

  if (response.status === 404 && isNavigationRequest(pathname)) {
    const shell = await fetchSpaShell(request, assets);
    if (shell) return shell;
  }

  return response;
}
