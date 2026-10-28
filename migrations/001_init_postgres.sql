-- migrations/001_init_postgres.sql
-- Production PostgreSQL Schema for РассрочкаПро (Installment Sales & Financial Ledger)
-- All monetary amounts are stored in exact integer kopecks (BIGINT).

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'readonly')),
  status TEXT NOT NULL CHECK (status IN ('pending_email', 'pending_approval', 'active', 'blocked', 'rejected')),
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS installment_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  term_months INTEGER NOT NULL CHECK (term_months > 0 AND term_months <= 120),
  markup_percent NUMERIC(6,2) NOT NULL CHECK (markup_percent >= 0),
  down_payment_percent NUMERIC(5,2) NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
  down_payment_required BOOLEAN NOT NULL DEFAULT TRUE,
  rounding_rule TEXT NOT NULL CHECK (rounding_rule IN ('kopeck', 'ruble', 'ten_rubles')),
  early_payoff_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (early_payoff_discount_percent >= 0 AND early_payoff_discount_percent <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_history (
  id TEXT PRIMARY KEY,
  setting_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_value_json TEXT NOT NULL,
  new_value_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  changed_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  secondary_phone TEXT NOT NULL DEFAULT '',
  document_ref TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Магазин электроники',
  contact_info TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  client_id TEXT REFERENCES clients(id),
  item_name TEXT NOT NULL,
  item_category TEXT NOT NULL DEFAULT 'Электроника',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  purchase_price_kopecks BIGINT NOT NULL CHECK (purchase_price_kopecks >= 0),
  delivery_cost_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (delivery_cost_kopecks >= 0),
  other_cost_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (other_cost_kopecks >= 0),
  total_cost_kopecks BIGINT NOT NULL CHECK (total_cost_kopecks = purchase_price_kopecks + delivery_cost_kopecks + other_cost_kopecks),
  paid_to_supplier_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (paid_to_supplier_kopecks >= 0),
  supplier_debt_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (supplier_debt_kopecks >= 0),
  handover_status TEXT NOT NULL DEFAULT 'ready' CHECK (handover_status IN ('in_procurement', 'ready', 'handed_over', 'returned')),
  purchase_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  contract_number TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  purchase_id TEXT REFERENCES purchases(id),
  plan_id TEXT REFERENCES installment_plans(id),
  plan_version INTEGER NOT NULL DEFAULT 1,
  item_title TEXT NOT NULL,
  purchase_cost_kopecks BIGINT NOT NULL CHECK (purchase_cost_kopecks >= 0),
  extra_cost_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (extra_cost_kopecks >= 0),
  total_cost_kopecks BIGINT NOT NULL CHECK (total_cost_kopecks = purchase_cost_kopecks + extra_cost_kopecks),
  markup_percent NUMERIC(6,2) NOT NULL CHECK (markup_percent >= 0),
  sale_price_kopecks BIGINT NOT NULL CHECK (sale_price_kopecks >= total_cost_kopecks),
  down_payment_percent NUMERIC(5,2) NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
  down_payment_kopecks BIGINT NOT NULL CHECK (down_payment_kopecks >= 0 AND down_payment_kopecks <= sale_price_kopecks),
  financed_principal_kopecks BIGINT NOT NULL CHECK (financed_principal_kopecks = sale_price_kopecks - down_payment_kopecks),
  term_months INTEGER NOT NULL CHECK (term_months > 0),
  rounding_rule TEXT NOT NULL CHECK (rounding_rule IN ('kopeck', 'ruble', 'ten_rubles')),
  schedule_type TEXT NOT NULL DEFAULT 'equal' CHECK (schedule_type IN ('equal', 'custom')),
  start_date DATE NOT NULL,
  current_schedule_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'restructured', 'returned', 'cancelled')),
  closing_discount_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (closing_discount_kopecks >= 0),
  closed_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  change_reason TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contract_id, version)
);

CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  schedule_version INTEGER NOT NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  original_due_date DATE NOT NULL,
  planned_kopecks BIGINT NOT NULL CHECK (planned_kopecks > 0),
  paid_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (paid_kopecks >= 0 AND paid_kopecks <= planned_kopecks),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'superseded', 'waived')),
  promised_date DATE,
  postpone_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS overdue_contacts (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  schedule_item_id TEXT REFERENCES schedule_items(id),
  contact_channel TEXT NOT NULL CHECK (contact_channel IN ('phone', 'messenger', 'in_person')),
  summary TEXT NOT NULL,
  promised_date DATE,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS financial_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('cash', 'bank')),
  balance_kopecks BIGINT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  contract_id TEXT REFERENCES contracts(id),
  account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer')),
  amount_kopecks BIGINT NOT NULL CHECK (amount_kopecks > 0),
  allocated_kopecks BIGINT NOT NULL DEFAULT 0 CHECK (allocated_kopecks >= 0 AND allocated_kopecks <= amount_kopecks),
  unallocated_kopecks BIGINT NOT NULL CHECK (unallocated_kopecks = amount_kopecks - allocated_kopecks),
  is_down_payment BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed')),
  reversal_reason TEXT NOT NULL DEFAULT '',
  reversed_by TEXT REFERENCES users(id),
  event_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  schedule_item_id TEXT NOT NULL REFERENCES schedule_items(id),
  amount_kopecks BIGINT NOT NULL CHECK (amount_kopecks > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  related_account_id TEXT REFERENCES financial_accounts(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'client_payment',
    'purchase_payment',
    'delivery_expense',
    'operating_expense',
    'owner_injection',
    'owner_withdrawal',
    'internal_transfer_out',
    'internal_transfer_in',
    'client_refund',
    'supplier_refund',
    'reversal'
  )),
  category TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_kopecks BIGINT NOT NULL CHECK (amount_kopecks > 0),
  reference_type TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL DEFAULT '',
  reversal_of_id TEXT REFERENCES ledger_entries(id),
  reversal_reason TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  event_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('client', 'contract', 'purchase', 'payment', 'return')),
  entity_id TEXT NOT NULL,
  doc_category TEXT NOT NULL CHECK (doc_category IN ('contract_scan', 'receipt', 'transfer_proof', 'handover_act', 'return_act', 'photo', 'generated_template')),
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  sha256_hash TEXT NOT NULL,
  content_base64 TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256_hash TEXT NOT NULL,
  encrypted_alg TEXT NOT NULL DEFAULT 'AES-256-GCM',
  contracts_count INTEGER NOT NULL DEFAULT 0,
  ledger_net_kopecks BIGINT NOT NULL DEFAULT 0,
  verified_restore_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'verified', 'failed')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_email TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
