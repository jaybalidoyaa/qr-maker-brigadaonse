-- 0001_init.sql
-- Brigada Onse QR Code Generator — core schema (Cloudflare D1 / SQLite).
-- Additive migration: creates the initial tables only.

-- ---------------------------------------------------------------------------
-- Personnel records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personnel (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id            TEXT    NOT NULL UNIQUE,
  verification_token_hash TEXT    NOT NULL UNIQUE,
  verification_token_enc  TEXT    NOT NULL,
  full_name               TEXT    NOT NULL,
  address                 TEXT    NOT NULL DEFAULT '',
  group_name              TEXT    NOT NULL,
  position                TEXT    NOT NULL,
  profile_photo           TEXT,
  valid_until             TEXT,
  status                  TEXT    NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'suspended', 'revoked')),
  remarks                 TEXT,
  date_registered         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by              TEXT    NOT NULL,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_personnel_full_name   ON personnel (full_name);
CREATE INDEX IF NOT EXISTS idx_personnel_group_name  ON personnel (group_name);
CREATE INDEX IF NOT EXISTS idx_personnel_status      ON personnel (status);
CREATE INDEX IF NOT EXISTS idx_personnel_valid_until ON personnel (valid_until);
CREATE INDEX IF NOT EXISTS idx_personnel_created_at  ON personnel (created_at);

-- ---------------------------------------------------------------------------
-- Administrator accounts (authentication references)
-- Passwords are stored only as salted PBKDF2-HMAC-SHA256 hashes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  display_name   TEXT,
  role           TEXT    NOT NULL DEFAULT 'admin'
                         CHECK (role IN ('admin', 'viewer')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (username);

-- ---------------------------------------------------------------------------
-- Audit log of authorized administrative actions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER,
  actor_name   TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  entity_type  TEXT    NOT NULL DEFAULT 'personnel',
  entity_id    TEXT,
  entity_label TEXT,
  metadata     TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity      ON audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Verification events (operational monitoring only).
-- Deliberately stores no IP addresses or device fingerprints.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER,
  token_hash   TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_verification_events_created_at ON verification_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_events_token       ON verification_events (token_hash);
CREATE INDEX IF NOT EXISTS idx_verification_events_status      ON verification_events (status);
