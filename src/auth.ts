/**
 * Authentication: password login, server-side sessions, CSRF and origin
 * checks, and D1-backed login rate limiting.
 */

import type { Env } from './config';
import { loginMaxAttempts, loginWindowSeconds, sessionTtlSeconds } from './config';
import type { AdminRow } from './db';
import {
  HttpError,
  parseCookies,
  randomToken,
  serializeCookie,
  sha256Hex,
  timingSafeEqual,
} from './util';
import { hashPassword, verifyPassword } from './crypto';
import type { Ctx } from './router';

export const SESSION_COOKIE = 'bo_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface SessionRow {
  id: number;
  token_hash: string;
  admin_user_id: number;
  csrf_token: string;
  created_at: string;
  expires_at: number;
  last_seen_at: number;
}

export interface AuthContext {
  admin: AdminRow;
  session: SessionRow;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export interface IssuedSession {
  token: string;
  csrfToken: string;
  maxAge: number;
}

export async function createSession(env: Env, adminId: number): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + sessionTtlSeconds(env);

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, admin_user_id, csrf_token, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), adminId, csrfToken, expiresAt, now)
    .run();

  return { token, csrfToken, maxAge: sessionTtlSeconds(env) };
}

export async function loadSession(
  env: Env,
  token: string,
): Promise<AuthContext | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.*, a.username, a.password_hash, a.display_name, a.role, a.is_active,
            a.created_at AS admin_created_at, a.last_login_at
       FROM sessions s
       JOIN admin_users a ON a.id = s.admin_user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SessionRow & AdminRow & { admin_created_at: string; is_active: number }>();

  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.is_active !== 1) return null;

  // Sliding session: refresh expiry at most every 5 minutes.
  if (now - row.last_seen_at > 300) {
    const newExpiry = now + sessionTtlSeconds(env);
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, newExpiry, tokenHash)
      .run();
    row.expires_at = newExpiry;
  }

  const admin: AdminRow = {
    id: row.admin_user_id,
    username: row.username,
    password_hash: row.password_hash,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
    created_at: row.admin_created_at,
    last_login_at: row.last_login_at,
  };
  return { admin, session: row };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .run();
}

export function sessionCookie(token: string, maxAge: number): string {
  return serializeCookie(SESSION_COOKIE, token, { maxAge, httpOnly: true, secure: true, sameSite: 'Strict' });
}

export function clearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure: true, sameSite: 'Strict' });
}

/* -------------------------------------------------------------------------- */
/* Request guards                                                              */
/* -------------------------------------------------------------------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for state-changing requests:
 *  1. Origin/Referer must match the request origin (blocks cross-site forms).
 *  2. Admin mutations must also carry the session's CSRF token header.
 */
export function assertSameOrigin(ctx: Ctx): void {
  if (SAFE_METHODS.has(ctx.req.method)) return;
  const origin = ctx.req.headers.get('origin');
  if (origin) {
    if (origin !== ctx.url.origin) throw new HttpError(403, 'Cross-origin request rejected.');
    return;
  }
  const referer = ctx.req.headers.get('referer');
  if (referer) {
    try {
      if (new URL(referer).origin !== ctx.url.origin) {
        throw new HttpError(403, 'Cross-origin request rejected.');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(403, 'Cross-origin request rejected.');
    }
    return;
  }
  // No Origin and no Referer: non-browser client. Accept it — cookie is
  // SameSite=Strict, so a browser can never produce this state cross-site.
}

export function assertCsrf(session: SessionRow, ctx: Ctx): void {
  if (SAFE_METHODS.has(ctx.req.method)) return;
  const provided = ctx.req.headers.get(CSRF_HEADER) ?? '';
  if (!provided || !timingSafeEqual(provided, session.csrf_token)) {
    throw new HttpError(403, 'Missing or invalid CSRF token.');
  }
}

export async function requireAuth(ctx: Ctx): Promise<AuthContext> {
  assertSameOrigin(ctx);
  const token = parseCookies(ctx.req)[SESSION_COOKIE] ?? '';
  const auth = await loadSession(ctx.env, token);
  if (!auth) throw new HttpError(401, 'Authentication required.');
  assertCsrf(auth.session, ctx);
  return auth;
}

/** Public endpoints: reject cross-site browser requests outright. */
export function assertPublicOrigin(ctx: Ctx): void {
  assertSameOrigin(ctx);
}

/* -------------------------------------------------------------------------- */
/* Login rate limiting (stored in D1 so it spans isolates)                    */
/* -------------------------------------------------------------------------- */

export interface RateState {
  allowed: boolean;
  retryAfterSeconds: number;
  attempts: number;
}

interface AttemptRow {
  key: string;
  attempts: number;
  window_start: number;
  locked_until: number | null;
}

export async function loginRateState(
  env: Env,
  key: string,
  now = Math.floor(Date.now() / 1000),
): Promise<RateState> {
  const row = await env.DB.prepare('SELECT * FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<AttemptRow>();

  const windowSeconds = loginWindowSeconds(env);
  const maxAttempts = loginMaxAttempts(env);

  if (!row) return { allowed: true, retryAfterSeconds: 0, attempts: 0 };

  if (row.locked_until && row.locked_until > now) {
    return { allowed: false, retryAfterSeconds: row.locked_until - now, attempts: row.attempts };
  }
  if (now - row.window_start > windowSeconds) {
    return { allowed: true, retryAfterSeconds: 0, attempts: 0 };
  }
  if (row.attempts >= maxAttempts) {
    const retryAfter = Math.max(1, row.window_start + windowSeconds - now);
    return { allowed: false, retryAfterSeconds: retryAfter, attempts: row.attempts };
  }
  return { allowed: true, retryAfterSeconds: 0, attempts: row.attempts };
}

export async function registerFailedLogin(
  env: Env,
  key: string,
  now = Math.floor(Date.now() / 1000),
): Promise<RateState> {
  const windowSeconds = loginWindowSeconds(env);
  const maxAttempts = loginMaxAttempts(env);
  const row = await env.DB.prepare('SELECT * FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<AttemptRow>();

  const expired = !row || now - row.window_start > windowSeconds;
  const attempts = (expired ? 0 : row!.attempts) + 1;
  const windowStart = expired ? now : row!.window_start;
  const lockedUntil = attempts >= maxAttempts ? now + windowSeconds : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (key, attempts, window_start, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts,
                                    window_start = excluded.window_start,
                                    locked_until = excluded.locked_until`,
  )
    .bind(key, attempts, windowStart, lockedUntil)
    .run();

  if (lockedUntil) {
    return { allowed: false, retryAfterSeconds: windowSeconds, attempts };
  }
  return { allowed: true, retryAfterSeconds: 0, attempts };
}

export async function clearLoginAttempts(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

export async function attemptKey(username: string, ip: string): Promise<string> {
  return sha256Hex(`${username.trim().toLowerCase()}|${ip}`);
}

/* -------------------------------------------------------------------------- */
/* Login                                                                       */
/* -------------------------------------------------------------------------- */

export interface LoginResult {
  admin: AdminRow;
  session: IssuedSession;
}

export async function authenticate(
  env: Env,
  username: string,
  password: string,
): Promise<AdminRow | null> {
  const admin = await env.DB.prepare('SELECT * FROM admin_users WHERE username = ?')
    .bind(username.trim())
    .first<AdminRow>();
  if (!admin || admin.is_active !== 1) {
    // Burn comparable CPU time so unknown usernames are not distinguishable
    // from wrong passwords by response timing. Failures are logged, never
    // surfaced (that would leak which usernames exist).
    await hashPassword(password).catch((err) => {
      console.error('pbkdf2 timing-burn failed:', err instanceof Error ? err.message : String(err));
    });
    return null;
  }
  const ok = await verifyPassword(password, admin.password_hash);
  return ok ? admin : null;
}
