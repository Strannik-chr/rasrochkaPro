-- =============================================================================
-- РассрочкаПро — Миграция 003: Production Hardening, Indexes & Integrity Constraints
-- Target: PostgreSQL 15+ (Supabase / Neon) & SQLite 3.45+
-- =============================================================================

BEGIN;

-- 1. Индекс по номеру телефона клиента для быстрой проверки дубликатов и поиска
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

-- 2. Индекс по привязке документов (entity_type, entity_id) и контрольной сумме SHA-256
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256_hash);

-- 3. Индекс по платежам (client_id, contract_id, event_date) для ускорения сверки и отчётности
CREATE INDEX IF NOT EXISTS idx_payments_client_contract ON payments(client_id, contract_id, event_date DESC);

-- 4. Индекс по проводкам главной книги (account_id, status, event_date) для отчётов и экспорта CSV
CREATE INDEX IF NOT EXISTS idx_ledger_account_date ON ledger_entries(account_id, status, event_date DESC);

-- 5. Индекс по журналу аудита (entity_type, entity_id, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_audit_entity_created ON audit_logs(entity_type, entity_id, created_at DESC);

COMMIT;
