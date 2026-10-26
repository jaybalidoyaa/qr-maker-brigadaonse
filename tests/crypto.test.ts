import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, hashPassword, verifyPassword } from '../src/crypto';
import {
  HttpError,
  escapeHtml,
  fromBase64,
  fromBase64Url,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  toBase64,
  toBase64Url,
} from '../src/util';
import type { Env } from '../src/config';

const KEY = toBase64(new Uint8Array(32).fill(7));
const env = { TOKEN_ENCRYPTION_KEY: KEY } as unknown as Env;
const weakEnv = { TOKEN_ENCRYPTION_KEY: '' } as unknown as Env;

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple', 10_000);
    expect(stored.startsWith('pbkdf2-sha256$10000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('produces a unique salt for every hash', async () => {
    const a = await hashPassword('same-password', 10_000);
    const b = await hashPassword('same-password', 10_000);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$abc$AA==$BB==')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('never stores the plaintext password', async () => {
    const stored = await hashPassword('SuperSecret123!', 10_000);
    expect(stored).not.toContain('SuperSecret123!');
  });
});

describe('verification token encryption', () => {
  it('round-trips a token', async () => {
    const token = randomToken(32);
    const enc = await encryptToken(env, token);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain(token);
    expect(await decryptToken(env, enc)).toBe(token);
  });

  it('produces a different ciphertext every time (fresh IV)', async () => {
    const token = 'fixed-token-value';
    expect(await encryptToken(env, token)).not.toBe(await encryptToken(env, token));
  });

  it('fails loudly when the key is missing', async () => {
    await expect(encryptToken(weakEnv, 'token')).rejects.toBeInstanceOf(HttpError);
    await expect(decryptToken(weakEnv, 'v1.AA==.BB==')).rejects.toBeInstanceOf(HttpError);
  });

  it('fails when the key does not match', async () => {
    const enc = await encryptToken(env, 'token');
    const other = {
      TOKEN_ENCRYPTION_KEY: toBase64(new Uint8Array(32).fill(9)),
    } as unknown as Env;
    await expect(decryptToken(other, enc)).rejects.toBeInstanceOf(HttpError);
  });

  it('detects tampered ciphertext', async () => {
    const enc = await encryptToken(env, 'token');
    const [v, iv, ct] = enc.split('.');
    const bytes = fromBase64(ct);
    bytes[0] ^= 0xff;
    const tampered = `${v}.${iv}.${toBase64(bytes)}`;
    await expect(decryptToken(env, tampered)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('token helpers', () => {
  it('generates long, URL-safe, non-sequential tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = randomToken(32);
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
      expect(t).not.toContain('=');
      tokens.add(t);
    }
    expect(tokens.size).toBe(200);
  });

  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it('hashes deterministically with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares strings in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('neutralises HTML and script injection', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(escapeHtml("O'Neil & <b>Co</b>")).toBe('O&#39;Neil &amp; &lt;b&gt;Co&lt;/b&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
