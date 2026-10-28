# DATA_MODEL.md — Схема данных и ограничения целостности

Все денежные поля имеют суффикс `_kopecks` и хранятся в целочисленном типе (`BIGINT` в PostgreSQL / `INTEGER` в SQLite), исключая ошибки с плавающей точкой.

## 1. Пользователи, Сессии и Безопасность
- **`users`**:
  - `id` (PK), `email` (UNIQUE), `full_name`, `phone`
  - `password_hash` (scrypt/Argon2), `role` (`'owner' | 'staff' | 'readonly'`)
  - `status` (`'pending_email' | 'pending_approval' | 'active' | 'blocked' | 'rejected'`)
  - `mfa_enabled` (BOOLEAN), `mfa_secret` (TEXT, nullable)
  - `failed_login_attempts` (INT), `locked_until` (TIMESTAMP)
  - `approved_by` (FK → `users.id`), `approved_at`, `created_at`
- **`verification_codes`**:
  - `id` (PK), `email`, `purpose` (`'email_verify' | 'password_reset'`), `code_hash`, `attempts`, `expires_at`, `used_at`, `created_at`
- **`sessions`**:
  - `id` (PK), `user_id` (FK → `users.id`), `token_hash` (UNIQUE), `csrf_token`, `ip_address`, `user_agent`, `expires_at`, `revoked_at`, `created_at`
- **`audit_logs`** (append-only):
  - `id` (PK), `actor_user_id`, `actor_email`, `action`, `entity_type`, `entity_id`, `summary`, `metadata_json`, `created_at`

## 2. Настройки рассрочки (Версионируемые)
- **`installment_plans`**:
  - `id` (PK), `name`, `term_months` (CHECK > 0), `markup_percent` (NUMERIC/INT basis points или % с 2 знаками), `down_payment_percent` (CHECK BETWEEN 0 AND 100), `down_payment_required` (BOOLEAN), `rounding_rule` (`'kopeck' | 'ruble' | 'ten_rubles'`), `early_payoff_Policy` (`'full_balance' | 'proportional_markup_discount' | 'manual_owner'`), `is_active` (BOOLEAN), `version` (INT), `updated_by`, `created_at`, `updated_at`
- **`settings_history`**:
  - `id` (PK), `setting_type`, `entity_id`, `old_value_json`, `new_value_json`, `changed_by` (FK → `users.id`), `reason`, `created_at`

## 3. Клиенты, Поставщики и Закупки
- **`clients`**:
  - `id` (PK), `full_name`, `phone`, `secondary_phone`, `document_ref` (минимально необходимые реквизиты для договора), `address`, `notes`, `status` (`'active' | 'archived'`), `created_by`, `created_at`
- **`suppliers`**:
  - `id` (PK), `name`, `category` (Магазин электроники, Бытовая техника, Автотовары и др.), `contact_info`, `notes`, `is_active`, `created_at`
- **`purchases`**:
  - `id` (PK), `supplier_id` (FK → `suppliers.id`), `client_id` (FK → `clients.id`, nullable), `item_name`, `item_category`, `quantity` (CHECK > 0), `purchase_price_kopecks` (CHECK >= 0), `delivery_cost_kopecks` (CHECK >= 0), `other_cost_kopecks` (CHECK >= 0), `total_cost_kopecks` (CHECK = purchase + delivery + other), `paid_to_supplier_kopecks` (CHECK >= 0), `supplier_debt_kopecks`, `handover_status` (`'in_procurement' | 'ready' | 'handed_over' | 'returned'`), `purchase_date`, `notes`, `created_by`, `created_at`

## 4. Договоры и Версионируемые Графики Платежей
- **`contracts`**:
  - `id` (PK), `contract_number` (UNIQUE, например `ДГ-2026-0001`), `client_id` (FK → `clients.id`), `purchase_id` (FK → `purchases.id`), `plan_id` (FK → `installment_plans.id`, nullable для индивидуальных условий), `plan_version` (INT)
  - `item_title`, `purchase_cost_kopecks`, `extra_cost_kopecks`, `total_cost_kopecks`
  - `markup_percent` (REAL/NUMERIC), `sale_price_kopecks`, `down_payment_percent` (REAL/NUMERIC), `down_payment_kopecks`, `financed_principal_kopecks` (`sale_price_kopecks - down_payment_kopecks`)
  - `term_months` (INT), `rounding_rule`, `schedule_type` (`'equal' | 'custom'`), `start_date`
  - `current_schedule_version` (INT), `status` (`'draft' | 'active' | 'completed' | 'restructured' | 'returned' | 'cancelled'`), `closed_at`, `closing_discount_kopecks` (DEFAULT 0), `notes`, `created_by`, `created_at`
- **`schedule_versions`**:
  - `id` (PK), `contract_id` (FK → `contracts.id`), `version` (INT), `change_reason`, `created_by`, `created_at` (UNIQUE `(contract_id, version)`)
- **`schedule_items`**:
  - `id` (PK), `contract_id` (FK → `contracts.id`), `schedule_version` (INT), `installment_number` (INT), `due_date` (TEXT YYYY-MM-DD), `original_due_date` (TEXT), `planned_kopecks` (CHECK > 0), `paid_kopecks` (CHECK >= 0 AND paid_kopecks <= planned_kopecks), `status` (`'pending' | 'partial' | 'paid' | 'overdue' | 'superseded' | 'waived'`), `promised_date` (TEXT, nullable), `postpone_reason` (TEXT, nullable)
- **`overdue_contacts`**:
  - `id` (PK), `contract_id` (FK), `schedule_item_id` (FK), `contact_channel` (`'phone' | 'messenger' | 'in_person'`), `summary`, `promised_date`, `created_by`, `created_at`

## 5. Платежи, Ручное Распределение и Касса/Банк
- **`financial_accounts`**:
  - `id` (PK), `name` (Касса наличных, Расчётный счёт, Карта приёма переводов), `account_type` (`'cash' | 'bank'`), `balance_kopecks` (INT), `is_active` (BOOLEAN)
- **`payments`**:
  - `id` (PK), `idempotency_key` (UNIQUE), `client_id` (FK → `clients.id`), `contract_id` (FK → `contracts.id`, nullable — поддержка нераспределённых платежей без указания договора), `account_id` (FK → `financial_accounts.id`), `payment_method` (`'cash' | 'bank_transfer'`), `amount_kopecks` (CHECK > 0), `allocated_kopecks` (CHECK >= 0 AND allocated_kopecks <= amount_kopecks), `unallocated_kopecks` (CHECK = amount_kopecks - allocated_kopecks), `is_down_payment` (BOOLEAN), `status` (`'confirmed' | 'reversed'`), `reversal_reason`, `reversed_by`, `event_date`, `created_by`, `created_at`
- **`payment_allocations`**:
  - `id` (PK), `payment_id` (FK → `payments.id`), `contract_id` (FK → `contracts.id`), `schedule_item_id` (FK → `schedule_items.id`), `amount_kopecks` (CHECK > 0), `status` (`'active' | 'reversed'`), `created_by`, `created_at`
- **`ledger_entries`** (Движение денег и финансовые операции):
  - `id` (PK), `idempotency_key` (UNIQUE), `account_id` (FK → `financial_accounts.id`), `related_account_id` (FK, для внутренних переводов), `entry_type` (`'client_payment' | 'purchase_payment' | 'delivery_expense' | 'operating_expense' | 'owner_injection' | 'owner_withdrawal' | 'internal_transfer_out' | 'internal_transfer_in' | 'client_refund' | 'supplier_refund' | 'reversal'`), `category`, `direction` (`'in' | 'out'`), `amount_kopecks` (CHECK > 0), `reference_type`, `reference_id`, `reversal_of_id` (FK → `ledger_entries.id`, nullable), `reversal_reason`, `description`, `event_date`, `status` (`'confirmed' | 'reversed'`), `created_by`, `created_at`

## 6. Документы и Резервные копии
- **`documents`**:
  - `id` (PK), `entity_type` (`'client' | 'contract' | 'purchase' | 'payment' | 'return'`), `entity_id`, `doc_Category` (`'contract_scan' | 'receipt' | 'transfer_proof' | 'handover_act' | 'return_act' | 'photo' | 'generated_template'`), `title`, `original_filename`, `stored_filename` (UUID), `mime_type`, `size_bytes`, `sha256_hash`, `created_by`, `created_at`
- **`backups`**:
  - `id` (PK), `filename`, `size_bytes`, `sha256_hash`, `encrypted_alg` (`'AES-256-GCM'`), `contracts_count`, `ledger_net_kopecks`, `verified_restore_at`, `status`, `created_by`, `created_at`
