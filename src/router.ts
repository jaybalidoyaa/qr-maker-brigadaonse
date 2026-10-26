/**
 * Minimal pattern router: "/api/personnel/:id/renew" style routes.
 */

import type { Env } from './config';
import { HttpError, json } from './util';

export interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  params: Record<string, string>;
  ip: string;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  private match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed.');
    return null;
  }

  async handle(req: Request, env: Env): Promise<Response | null> {
    const url = new URL(req.url);
    const found = this.match(req.method, url.pathname);
    if (!found) return null;

    const ctx: Ctx = {
      req,
      url,
      env,
      params: found.params,
      ip: req.headers.get('cf-connecting-ip') ?? 'unknown',
    };

    try {
      return await found.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(
          { ok: false, error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
          err.status,
        );
      }
      console.error('Unhandled route error', err instanceof Error ? err.message : String(err));
      return json({ ok: false, error: 'Internal server error.' }, 500);
    }
  }
}
