/**
 * Environment bindings and configuration helpers.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** AES-256 key (base64) used to encrypt verification tokens at rest. */
  TOKEN_ENCRYPTION_KEY?: string;

  ENVIRONMENT?: string;
  /** Absolute origin used to build QR URLs, e.g. https://qr.brigadaonse.org. Empty = derive from request. */
  PUBLIC_BASE_URL?: string;
  /** "hidden" (default) never shows the residential address publicly; "full" shows it. */
  PUBLIC_ADDRESS_MODE?: string;
  /** "true" (default) shows the personnel ID on the public verification page. */
  PUBLIC_SHOW_PERSONNEL_ID?: string;
  SESSION_TTL_HOURS?: string;
  LOGIN_MAX_ATTEMPTS?: string;
  LOGIN_WINDOW_SECONDS?: string;
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionTtlSeconds(env: Env): number {
  return intVar(env.SESSION_TTL_HOURS, 12) * 3600;
}

export function loginMaxAttempts(env: Env): number {
  return intVar(env.LOGIN_MAX_ATTEMPTS, 5);
}

export function loginWindowSeconds(env: Env): number {
  return intVar(env.LOGIN_WINDOW_SECONDS, 900);
}

/** Absolute origin for public verification URLs (QR payload). */
export function publicBaseUrl(env: Env, request: Request): string {
  const configured = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return new URL(request.url).origin;
}

export function verificationUrl(env: Env, request: Request, token: string): string {
  return `${publicBaseUrl(env, request)}/verify/${token}`;
}

/** Default policy: the full residential address is NEVER shown publicly. */
export function publicAddressMode(env: Env): 'hidden' | 'full' {
  return (env.PUBLIC_ADDRESS_MODE ?? 'hidden').toLowerCase() === 'full' ? 'full' : 'hidden';
}

export function publicShowsPersonnelId(env: Env): boolean {
  return (env.PUBLIC_SHOW_PERSONNEL_ID ?? 'true').toLowerCase() !== 'false';
}
