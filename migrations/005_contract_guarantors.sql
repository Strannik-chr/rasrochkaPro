-- 005_contract_guarantors.sql
-- Миграция для поддержки одного или нескольких поручителей по договору рассрочки (many-to-many между contracts и clients)

CREATE TABLE IF NOT EXISTS contract_guarantors (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  guarantor_order INTEGER NOT NULL DEFAULT 1 CHECK (guarantor_order > 0),
  notes TEXT NOT NULL DEFAULT '',
  signed_guarantee_received INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(contract_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_guarantors_contract ON contract_guarantors(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_guarantors_client ON contract_guarantors(client_id);

-- Дополнительные атрибуты документов для привязки сканов/фото паспорта и поручительства к конкретному поручителю
ALTER TABLE documents ADD COLUMN guarantor_client_id TEXT;
ALTER TABLE documents ADD COLUMN guarantor_doc_type TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_documents_guarantor_client ON documents(guarantor_client_id);
