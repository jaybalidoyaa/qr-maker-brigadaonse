/**
 * Request pipeline: /api/* and /verify/* are handled by the Worker; every
 * other path falls through to Workers Static Assets.
 */

import type { Env } from './config';
import { apiRouter } from './routes/api';
import { renderVerifyPage } from './routes/verify';
import { apiError } from './util';

const api = apiRouter();

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/api' || path.startsWith('/api/')) {
      const response = await api.handle(request, env);
      if (response) return response;
      return apiError('Not found.', 404);
    }

    if (path === '/verify' || path.startsWith('/verify/')) {
      const token = decodeURIComponent(path.slice('/verify/'.length) ?? '');
      return await renderVerifyPage(env, request, token);
    }

    // Static assets: /, /admin/*, /assets/*, favicon …
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404 && request.method === 'GET') {
      // Friendly fallback for the admin SPA and unknown routes.
      const fallback = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
      if (fallback.ok) return fallback;
    }
    return assetResponse;
  } catch (err) {
    console.error('Unhandled error', err instanceof Error ? err.message : String(err));
    if (path.startsWith('/api/')) return apiError('Internal server error.', 500);
    return new Response('Internal server error', { status: 500 });
  }
}
