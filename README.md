# Brigada Onse QR Code Generator & Personnel Verification System

**Organization:** Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.
**Public verification domain:** `https://qr.brigadaonse.org`
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
`ASSETS`, D1 binding `DB` → database `brigada-onse-qr` with `migrations_dir: "migrations"`,
and an `env.production` block that adds the `qr.brigadaonse.org` custom domain,
production variables and `workers_dev: true`.

**Status: configured.** The real database ID `aa53163e-cf6a-4906-8cba-769398d7c045`
(created 2026-10-26 in the account `951c…367e`) is already in both the top-level and
`env.production` blocks. If you fork this into a different Cloudflare account, run
`npm run db:create` and replace that value. A D1 database ID is an identifier, not a secret.

---

## 5. Environment variables and secrets

| Name | Required | Default | Purpose |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **yes (secret)** | – | base64 32-byte AES-256 key for token encryption |
| `ENVIRONMENT` | no | `development` | informational |
| `PUBLIC_BASE_URL` | no | derived from request | origin used to build QR URLs (set `https://qr.brigadaonse.org`) |
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
# 1. Create the database (prints the real database_id) — already run for this project
npx wrangler d1 create brigada-onse-qr

# 2. Put that ID into wrangler.jsonc (top-level and env.production) — already done

# 3. Apply migrations locally
npm run db:migrate:local

# 4. Apply migrations to production (after the ID is in place) — already done
npm run db:migrate:remote
```

The database must be created, its ID inserted, and migrations applied **before** the
production application can serve traffic correctly.

---

## 8. Deploying the Worker

**Production is deployed** (see section 10). The exact sequence used:

```bash
npm run build && npm test           # required checks
npx wrangler d1 create brigada-onse-qr
npx wrangler d1 migrations apply brigada-onse-qr --remote
node scripts/generate-key.mjs | npx wrangler secret put TOKEN_ENCRYPTION_KEY --env production
npx wrangler deploy --env production
```

CI: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs typecheck + tests and
deploys **only** when manually triggered (`workflow_dispatch`). Configure repository secrets
`CLOUDFLARE_API_TOKEN` (minimum scope: *Account → Workers Scripts → Edit*) and
`CLOUDFLARE_ACCOUNT_ID`. Automatic destructive migration application is intentionally not
enabled.

---

## 9. Custom domain: `qr.brigadaonse.org`

**Configured and verified on 2026-10-26.** The route lives in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "qr.brigadaonse.org", "custom_domain": true }]
```

> The host was originally provisioned as `verify.brigadaonse.org` and changed to
> `qr.brigadaonse.org` the same day. The route, `PUBLIC_BASE_URL`, the landing-page example
> and every QR URL now use the new host, and the old host is no longer attached to the
> Worker (it returns 530 / NXDOMAIN). Because the production database held **0 personnel
> records** at the changeover, no printed QR codes needed reissuing. If you ever rename the
> host again after printing cards, every existing QR keeps working only if you keep the old
> host routed to the Worker as an alias.

Deployed with `npx wrangler deploy --env production`, which created the custom-domain
binding and its DNS record in the `brigadaonse.org` zone (already on the account).

Verified: public resolvers (1.1.1.1, 8.8.8.8) return the Cloudflare addresses,
`https://qr.brigadaonse.org/api/health` returns 200 with a valid certificate
(`ssl_verify_result = 0`), `/` and `/admin/` return 200, protected APIs return 401, and an
unknown token returns the 404 INVALID page. Note that a local router's DNS cache can lag by
a few minutes — query a public resolver if a fresh machine cannot resolve it yet.

To move the domain later: edit `routes` in `wrangler.jsonc` and redeploy. To detach it
entirely, remove the entry and redeploy (or use the Cloudflare dashboard → Workers →
*brigada-onse-qr-verification* → Settings → Domains & Routes).

### Connecting the GitHub repository for Cloudflare-side builds (optional)

Wrangler deploys do **not** need a git connection. If you want Cloudflare to build and
deploy from GitHub instead, authorize the GitHub app in the Cloudflare dashboard:
Workers & Pages → *brigada-onse-qr-verification* → Settings → Builds & deployments →
*Connect to Git* → select `jaybalidoyaa/qr-maker-brigadaonse`. That authorization is an
interactive browser step on Cloudflare's side; it cannot be completed from the CLI, which
is why the dashboard reports **“Missing git connection.”**

---

## 10. Deployment status and remaining work

**Completed on 2026-10-26 (this machine, authenticated with Wrangler OAuth):**

| Step | Status |
|---|---|
| D1 database `brigada-onse-qr` created (`aa53163e-cf6a-4906-8cba-769398d7c045`, region APAC) | ✅ done |
| `database_id` written into `wrangler.jsonc` (top-level + `env.production`) | ✅ done |
| Remote migrations `0001_init.sql`, `0002_auth_infra.sql` applied | ✅ done — all 6 tables present |
| `TOKEN_ENCRYPTION_KEY` secret set for the `production` environment | ✅ done (value never printed or committed) |
| `npx wrangler deploy --env production` | ✅ done — version `d8a6851e-4e13-4b55-b2b0-d92e77a43d00` |
| Custom domain `qr.brigadaonse.org` attached + DNS record created | ✅ done |
| Domain switched `verify.` → `qr.` (route, `PUBLIC_BASE_URL`, docs) + redeploy | ✅ done — version `a06f2f39-4c87-4c74-af4a-12cc15dd6944` |
| Live checks: `/api/health` 200, `/` 200, `/admin/` 200, `/api/personnel` 401, `/verify/<bad>` 404+INVALID, TLS valid | ✅ passed |
| Fallback URL `https://brigada-onse-qr-verification.balidoyajayson.workers.dev` | ✅ enabled |

**Still to do (owner):**

1. **Create the first administrator** — open `https://qr.brigadaonse.org/admin/`, click
   *“First time? Set up the administrator account”* and choose the production password.
   This was deliberately **not** done during deployment, so no default or machine-chosen
   production credential exists. Until then every admin API returns 401.
2. Register real personnel and scan a real QR end-to-end (the production database currently
   has 0 personnel rows — synthetic test data was never written to production).
3. Optional: add `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repository secrets so the
   GitHub Actions workflow can deploy.
4. Optional: connect the GitHub repo to Cloudflare's git builds (see section 9).

**Local verification (unchanged from the build):**

| Check | Result |
|---|---|
| `npm run build` (TypeScript, strict) | ✅ 0 errors |
| `npm test` (vitest, 4 files) | ✅ 42/42 passing |
| `node scripts/smoke-test.mjs` against `wrangler dev` + local D1 | ✅ 74/74 passing |
| Status rules incl. Manila boundary and all four failure states | ✅ |
| Auth, CSRF, origin check, rate limiting, address privacy, SQL/XSS attempts | ✅ |

---

## Notes on data handling

- Verification tokens are 256-bit random values; only their SHA-256 (for lookup) and an
  AES-256-GCM ciphertext (for reprinting) are stored.
- Verification events record no IP addresses or personal tracking data.
- Tests and seeds use synthetic records only; no real personnel data ships with the repo.
