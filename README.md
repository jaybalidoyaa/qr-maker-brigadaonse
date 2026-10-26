# Brigada Onse QR Code Generator & Personnel Verification System

**Organization:** Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.
**Public verification domain:** `https://verify.brigadaonse.org`
**Stack:** Cloudflare Workers (TypeScript) · Cloudflare D1 · Workers Static Assets · Wrangler

A Cloudflare-native registration, QR issuance and public verification system for volunteer
personnel. Administrators register personnel, generate a permanent QR code and printable ID
card, and manage renewals, suspensions and revocations. Anyone scanning a card sees the
record's current status served straight from D1 — no client-side caching, no stale codes.

---

## 1. Features implemented

**Registration & QR issuance**
- Registration form: Full Name, Address, Group, Position, Valid Until (required) plus
  Personnel ID, Profile Photo, Status, Date Registered, Last Updated, Created By, Remarks.
- Save first, then generate the QR — the QR URL is minted once at creation and never changes,
  even after edits or renewals.
- Each record carries a unique human Personnel ID and a **separate 256-bit random verification
  token** (`crypto.getRandomValues`, base64url, 43 characters). Sequential database IDs are
  never used as tokens and are never exposed to the public.
- QR output in **SVG and PNG** (server-rendered, dependency-free encoder), with preview,
  download PNG/SVG, copy-link and print-ID-card in the dashboard.
- Professional 86 × 54 mm landscape ID card layout for printing (`Print ID card`).

**Cloudflare D1**
- Version-controlled migrations in [`migrations/`](migrations) for `personnel`,
  `admin_users`, `audit_logs`, `verification_events`, `sessions`, `login_attempts`.
- Every query is a prepared statement with bound parameters; dynamic sorting uses a
  whitelisted column map — no user input is ever interpolated into SQL.
- `db.batch()` (atomic) is used for multi-statement reads; multi-record writes are single
  statements, so no partial-write windows exist.

**API (Cloudflare Worker)**
| Method | Route | Access |
|---|---|---|
| GET | `/api/health` | public |
| POST | `/api/setup` | public, closed after the first admin exists |
| POST | `/api/auth/login`, `/api/auth/logout` | public |
| GET | `/api/auth/me` | admin |
| GET | `/api/dashboard`, `/api/groups` | admin |
| GET/POST | `/api/personnel` | admin |
| GET/PUT | `/api/personnel/:id` | admin |
| POST | `/api/personnel/:id/renew` `/suspend` `/reactivate` `/revoke` | admin |
| GET | `/api/personnel/:id/qr?format=svg\|png&download=1` | admin |
| GET | `/api/audit` | admin |
| GET | `/api/verify/:token` | public (approved fields only) |
| GET | `/verify/:token` | public HTML page |

**Public verification page** — server-rendered, `noindex`, shows organization, full name,
Personnel ID (configurable), Group, Position, Valid Until, status badge, reason and the
verification timestamp in `Asia/Manila`. The residential address is **not** shown unless
`PUBLIC_ADDRESS_MODE=full`.

Status rules are enforced on the server, in this order: unknown token → `INVALID`;
`revoked` → `REVOKED`; `suspended` → `SUSPENDED`; missing/malformed validity date → `INVALID`
(never auto-valid); date before today in Manila → `EXPIRED`; otherwise → `ACTIVE / VALID`.
A record is valid through the whole `valid_until` day in `Asia/Manila` and expires at
00:00 Manila the next day — covered by boundary tests in [`tests/status.test.ts`](tests/status.test.ts).

**Administration dashboard** (`/admin/`, vanilla JS — no framework added)
Dashboard summary · registration · directory with search, status/group filters, sort and
pagination · record editing · QR generation/downloading · ID card printing · renewal ·
suspend/reactivate/revoke · audit history (global and per record) · expiration monitor
(expired, expiring within 30 days, suspended).

**Security**
- Passwords: PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random salt (WebCrypto).
  No plaintext passwords, no default production credentials.
- Sessions: server-side rows storing only the SHA-256 of the token; cookie is
  `HttpOnly; Secure; SameSite=Strict` with a sliding 12-hour expiry.
- CSRF: `Origin`/`Referer` must match on every state-changing request **and** admin mutations
  must carry the session CSRF token header.
- Login rate limiting: 5 failed attempts per 900-second window per username+IP, stored in D1
  so it spans isolates; unknown usernames still burn a full PBKDF2 round (no timing oracle).
- Verification tokens are stored **hashed** (indexed lookup, constant-time comparison of the
  hash) and **AES-256-GCM encrypted** so the QR can be reprinted; the key never enters the
  database.
- Private address never appears in public responses or audit metadata; audit records store
  changed field *names*, not values.
- `escapeHtml()` on every server-rendered value; JSON endpoints never reflect input as HTML.
- Rate-limited, origin-checked, input-validated API with consistent `{ok, error, details}`
  JSON and proper HTTP status codes (400/401/403/404/409/413/422/429/500).

---

## 2. Repository structure

```
.
├── .dev.vars.example          # placeholders only (copy to .dev.vars, git-ignored)
├── .github/workflows/deploy.yml
├── .gitignore
├── README.md
├── migrations/
│   ├── 0001_init.sql          # personnel, admin_users, audit_logs, verification_events
│   └── 0002_auth_infra.sql    # sessions, login_attempts
├── package.json
├── public/
│   ├── index.html             # public landing page
│   └── admin/                 # administration SPA (index.html, app.js, styles.css)
├── scripts/
│   ├── generate-key.mjs       # TOKEN_ENCRYPTION_KEY generator
│   ├── seed.sql               # development-only admin (never apply with --remote)
│   └── smoke-test.mjs         # end-to-end test against a running dev server
├── src/
│   ├── auth.ts                # sessions, CSRF/origin guards, login rate limiting
│   ├── config.ts              # Env bindings and configuration helpers
│   ├── crypto.ts              # PBKDF2 hashing + AES-GCM token encryption
│   ├── db.ts                  # all D1 queries (prepared statements)
│   ├── index.ts               # Worker entry point
│   ├── png.ts                 # dependency-free PNG encoder
│   ├── qr.ts                  # QR → SVG/PNG rendering
│   ├── router.ts              # minimal pattern router
│   ├── server.ts              # request pipeline (API / verify / assets)
│   ├── status.ts              # verification status rules (Asia/Manila)
│   ├── util.ts                # responses, escaping, tokens, cookies
│   ├── validate.ts            # personnel payload validation
│   └── routes/
│       ├── api.ts             # JSON API
│       └── verify.ts          # server-rendered verification page
├── tests/                     # vitest unit tests (status, validation, crypto, QR/PNG)
├── tsconfig.json
├── vitest.config.ts
└── wrangler.jsonc
```

---

## 3. D1 schema

Applied from [`migrations/`](migrations):

- **personnel** — `id` (internal, never public), `personnel_id` UNIQUE,
  `verification_token_hash` UNIQUE, `verification_token_enc`, `full_name`, `address`,
  `group_name`, `position`, `profile_photo`, `valid_until` (`YYYY-MM-DD`), `status`
  (`active|suspended|revoked` CHECK), `remarks`, `date_registered`, `created_by`,
  `created_at`, `updated_at` + indexes on name, group, status, validity date, created_at.
- **admin_users** — `username` UNIQUE (case-insensitive), `password_hash`
  (`pbkdf2-sha256$600000$salt$hash`), `display_name`, `role`, `is_active`, timestamps.
- **sessions** — SHA-256 of the session token, admin FK, CSRF token, expiry, last seen.
- **login_attempts** — keyed by SHA-256(username|IP), attempt counter, window, lock-until.
- **audit_logs** — actor, action, entity type/id/label, JSON metadata, timestamp.
- **verification_events** — personnel id (nullable), token hash, status, timestamp.
  **No IP addresses or device fingerprints are stored.**

Migrations are additive; nothing drops or resets a table.

---

## 4. Wrangler configuration

[`wrangler.jsonc`](wrangler.jsonc) — worker name `brigada-onse-qr-verification`,
entry `src/index.ts`, `compatibility_date` `2026-10-26`, static assets `./public` bound to
`ASSETS`, D1 binding `DB` → database `brigada-onse-qr` with `migrations_dir: "migrations"`.

> **You must replace `REPLACE_WITH_ACTUAL_D1_DATABASE_ID`** in `wrangler.jsonc`
> (both the top-level block and `env.production`) with the real ID printed by
> `npm run db:create`. Local development works without it; production does not.

Never commit a real database ID belonging to someone else's account? The ID itself is not a
secret, but the placeholder must be replaced before deploying.

---

## 5. Environment variables and secrets

| Name | Required | Default | Purpose |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **yes (secret)** | – | base64 32-byte AES-256 key for token encryption |
| `ENVIRONMENT` | no | `development` | informational |
| `PUBLIC_BASE_URL` | no | derived from request | origin used to build QR URLs (set `https://verify.brigadaonse.org`) |
| `PUBLIC_ADDRESS_MODE` | no | `hidden` | `full` shows the residential address publicly |
| `PUBLIC_SHOW_PERSONNEL_ID` | no | `true` | `false` hides the Personnel ID publicly |
| `SESSION_TTL_HOURS` | no | `12` | session lifetime |
| `LOGIN_MAX_ATTEMPTS` | no | `5` | failed logins before lockout |
| `LOGIN_WINDOW_SECONDS` | no | `900` | lockout window |

Secrets never belong in the repository:

```bash
# local development
npm run secret:generate -- --dev        # writes TOKEN_ENCRYPTION_KEY to .dev.vars

# production
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

---

## 6. Local setup (exact commands)

```bash
npm install

npm run secret:generate -- --dev   # creates .dev.vars with a fresh key (git-ignored)

npm run db:migrate:local           # applies migrations/ to the local D1

npm run dev                        # starts wrangler dev on http://127.0.0.1:8787

npm run build                      # TypeScript typecheck (tsc --noEmit)
npm test                           # vitest unit tests
```

Then open `http://127.0.0.1:8787/admin/`, click **“First time? Set up the administrator
account”** and create the first admin (or seed a dev account with
`npm run db:seed:local` — user `admin`, password `ChangeMe123!`, local only).

Optional end-to-end test with the dev server running:

```bash
node scripts/smoke-test.mjs
```

> **Windows note:** local D1 state lives under the project path. If your checkout path is
> very long (deeper than Windows' `MAX_PATH`), `wrangler d1 … --local` fails with
> `internal error; reference = …`. Run migrations with a short persistence path instead:
> `npx wrangler d1 migrations apply brigada-onse-qr --local --persist-to C:/tmp/boqr-persist`
> and start dev with the same `--persist-to` flag.

---

## 7. Cloudflare D1 setup

```bash
# 1. Create the database (prints the real database_id)
npx wrangler d1 create brigada-onse-qr

# 2. Put that ID into wrangler.jsonc (top-level and env.production)

# 3. Apply migrations locally
npm run db:migrate:local

# 4. Apply migrations to production (after the ID is in place)
npm run db:migrate:remote
```

The database must be created, its ID inserted, and migrations applied **before** the
production application can serve traffic correctly.

---

## 8. Deploying the Worker

```bash
npm run build && npm test           # required checks
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler d1 migrations apply brigada-onse-qr --remote
npx wrangler deploy
```

CI: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs typecheck + tests and
deploys **only** when manually triggered (`workflow_dispatch`). Configure repository secrets
`CLOUDFLARE_API_TOKEN` (minimum scope: *Account → Workers Scripts → Edit*) and
`CLOUDFLARE_ACCOUNT_ID`. Automatic destructive migration application is intentionally not
enabled.

---

## 9. Custom domain: `verify.brigadaonse.org`

These steps must be performed in the owner's Cloudflare account — **they have not been run
and are not claimed as complete**:

1. Deploy the Worker (`npx wrangler deploy`).
2. Add the domain as a route/custom domain:
   `npx wrangler domains add verify.brigadaonse.org --env production`, **or** in the
   Cloudflare dashboard → Workers & Pages → `brigada-onse-qr-verification` →
   Settings → Domains & Routes → Add → Custom domain.
3. Confirm the zone `brigadaonse.org` is on the same Cloudflare account and its DNS shows the
   Worker route.
4. Confirm the SSL/TLS mode is “Full (strict)” and https:// responds with a certificate.
5. Test `https://verify.brigadaonse.org/api/health`, then scan a real QR and confirm
   `https://verify.brigadaonse.org/verify/<token>` renders the expected status.
6. Confirm D1 connectivity in production (`wrangler d1 execute brigada-onse-qr --remote
   --command "SELECT COUNT(*) FROM personnel"`).

---

## 10. Test results and remaining work

**Implemented and verified locally (2026-10-26):**

| Check | Result |
|---|---|
| `npm run build` (TypeScript, strict) | ✅ 0 errors |
| `npm test` (vitest, 4 files) | ✅ 42/42 passing |
| `node scripts/smoke-test.mjs` against `wrangler dev` + local D1 | ✅ 74/74 passing |
| Local D1 migrations (`0001`, `0002`) | ✅ applied |
| QR SVG + PNG rendering, PNG signature | ✅ |
| Status rules incl. Manila boundary and all four failure states | ✅ |
| Auth, CSRF, origin check, rate limiting, address privacy, SQL/XSS attempts | ✅ |

Smoke coverage includes: health, static assets, one-time setup, login/rate-limit/origin
rejection, registration, duplicate Personnel ID, validation errors, search/filter/sort
injection, QR URL stability across edits and renewals, QR download auth, public page + API
statuses (`VALID`, `EXPIRED`, `SUSPENDED`, `REVOKED`, `INVALID`), reactivation guard, audit
actions, dashboard counts and logout invalidation.

**Requires the owner's action (external configuration, not code):**

1. Create the D1 database and insert the real `database_id` into `wrangler.jsonc`.
2. Set `TOKEN_ENCRYPTION_KEY` (`wrangler secret put` in production).
3. Apply migrations with `--remote`.
4. Deploy and attach `verify.brigadaonse.org` (section 9).
5. Change/remove the seeded development admin before production use.
6. Optional: configure repository secrets for the GitHub Actions workflow.

**Not yet done:** production deployment, custom-domain attachment, and any verification
against the real Cloudflare account — none of these are claimed as complete.

---

## Notes on data handling

- Verification tokens are 256-bit random values; only their SHA-256 (for lookup) and an
  AES-256-GCM ciphertext (for reprinting) are stored.
- Verification events record no IP addresses or personal tracking data.
- Tests and seeds use synthetic records only; no real personnel data ships with the repo.
