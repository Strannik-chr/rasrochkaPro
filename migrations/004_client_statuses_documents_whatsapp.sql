-- ============================================================================
-- Миграция 004: Пороги статусов клиентов, версионирование прикреплённых
-- документов договоров и идемпотентность создания договоров
-- ============================================================================

CREATE TABLE IF NOT EXISTS status_rules_config (
  id TEXT PRIMARY KEY,
  grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_period_days >= 0 AND grace_period_days <= 60),
  complex_min_overdue_days INTEGER NOT NULL DEFAULT 15 CHECK (complex_min_overdue_days >= 1 AND complex_min_overdue_days <= 365),
  complex_consecutive_missed_count INTEGER NOT NULL DEFAULT 2 CHECK (complex_consecutive_missed_count >= 1 AND complex_consecutive_missed_count <= 24),
  complex_min_overdue_kopecks BIGINT NOT NULL DEFAULT 3000000 CHECK (complex_min_overdue_kopecks >= 100),
  reliable_max_past_late_count INTEGER NOT NULL DEFAULT 3 CHECK (reliable_max_past_late_count >= 1 AND reliable_max_past_late_count <= 24),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO status_rules_config (
  id, grace_period_days, complex_min_overdue_days,
  complex_consecutive_missed_count, complex_min_overdue_kopecks,
  reliable_max_past_late_count, updated_by, updated_at
) VALUES ('default', 0, 15, 2, 3000000, 3, 'system', NOW())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS contract_id TEXT REFERENCES contracts(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS previous_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS replaced_by_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_documents_contract ON documents(contract_id);
CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
