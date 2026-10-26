/**
 * Cloudflare Worker entry point.
 *
 * Bindings (see wrangler.jsonc):
 *   DB     — Cloudflare D1 database "brigada-onse-qr"
 *   ASSETS — Workers Static Assets (./public)
 */

import type { Env } from './config';
import { handleRequest } from './server';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
