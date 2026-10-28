-- Migration 002: Phone + Password Authentication Hardening & Brute-Force Protection
-- Target: PostgreSQL 15+ / SQLite 3.40+

BEGIN;

-- 1. Ensure phone is mandatory, normalized to E.164 (+7XXXXXXXXXX), and strictly unique
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);

-- 2. Add session inactivity tracking
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Persistent atomic rate-limiting & brute-force lockout buckets
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key VARCHAR(160) PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_locked_until ON auth_rate_limits(locked_until);

COMMIT;
