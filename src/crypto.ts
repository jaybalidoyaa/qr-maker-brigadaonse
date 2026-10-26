/**
 * Password hashing (PBKDF2-HMAC-SHA256) and verification-token encryption.
 * Uses the WebCrypto API available in Cloudflare Workers and Node.
 */

import type { Env } from './config';
import { fromBase64, HttpError, toBase64, timingSafeEqual } from './util';

const textEncoder = new TextEncoder();
export const PBKDF2_ITERATIONS = 600_000;

/** Hash format: pbkdf2-sha256$<iterations>$<base64 salt>$<base64 hash> */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 5_000_000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    expected.length * 8,
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Convenience used by tests to build weak-cost hashes. */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Verification-token encryption at rest                                      */
/* -------------------------------------------------------------------------- */

async function importAesKey(env: Env): Promise<CryptoKey> {
  const raw = (env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (!raw) {
    throw new HttpError(
      500,
      'Server misconfiguration: TOKEN_ENCRYPTION_KEY is not set. ' +
        'Run `npm run secret:generate -- --dev` for local development, or ' +
        '`npx wrangler secret put TOKEN_ENCRYPTION_KEY` before deploying.',
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new HttpError(500, 'Server misconfiguration: TOKEN_ENCRYPTION_KEY is not valid base64.');
  }
  if (bytes.length !== 32) {
    throw new HttpError(
      500,
      'Server misconfiguration: TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).',
    );
  }
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-256-GCM. Output: "v1.<base64 iv>.<base64 ciphertext>". */
export async function encryptToken(env: Env, token: string): Promise<string> {
  const key = await importAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(token));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decryptToken(env: Env, encoded: string): Promise<string> {
  const key = await importAesKey(env);
  const parts = (encoded ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new HttpError(500, 'Stored verification token is not in the expected encrypted format.');
  }
  try {
    const iv = fromBase64(parts[1]);
    const ct = fromBase64(parts[2]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError(
      500,
      'Unable to decrypt the verification token. TOKEN_ENCRYPTION_KEY does not match the key used when this record was created.',
    );
  }
}
