#!/usr/bin/env node
/**
 * Generates a random base64-encoded 32-byte key for TOKEN_ENCRYPTION_KEY.
 *
 *   node scripts/generate-key.mjs            -> prints the key
 *   node scripts/generate-key.mjs --dev      -> appends it to .dev.vars (creates if missing)
 *
 * Production:  npx wrangler secret put TOKEN_ENCRYPTION_KEY
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const key = randomBytes(32).toString('base64');

if (process.argv.includes('--dev')) {
  const path = '.dev.vars';
  if (existsSync(path) && readFileSync(path, 'utf8').includes('TOKEN_ENCRYPTION_KEY=')) {
    console.log(`${path} already contains TOKEN_ENCRYPTION_KEY — leaving it untouched.`);
  } else {
    appendFileSync(path, `${existsSync(path) ? '\n' : ''}TOKEN_ENCRYPTION_KEY=${key}\n`);
    console.log(`Appended a fresh TOKEN_ENCRYPTION_KEY to ${path} (git-ignored).`);
  }
} else {
  console.log(key);
}
