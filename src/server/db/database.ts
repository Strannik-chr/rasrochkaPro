import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword, normalizeRussianPhone } from '../security/crypto';
import { calculateContractAndSchedule } from '../finance/calculator';

let dbInstance: DatabaseSync | null = null;

export function getDb(customPath?: string): DatabaseSync {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const storagePath =
    customPath ||
    process.env.SQLITE_STORAGE_PATH ||
    path.resolve(process.cwd(), 'data', 'installment_ledger.sqlite');

  if (storagePath !== ':memory:') {
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(storagePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  initializeSchema(db);
  migrateAuthSchemaIfNeeded(db);
  seedInitialDataIfEmpty(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback error if already rolled back
    }
    throw err;
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'readonly')),
      status TEXT NOT NULL CHECK (status IN ('pending_email', 'pending_approval', 'active', 'blocked', 'rejected')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_changed_at TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_secret TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      bucket_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT NOT NULL,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      last_active_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installment_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      term_months INTEGER NOT NULL CHECK (term_months > 0 AND term_months <= 120),
      markup_percent REAL NOT NULL CHECK (markup_percent >= 0),
      down_payment_percent REAL NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
      down_payment_required INTEGER NOT NULL DEFAULT 1,
      rounding_rule TEXT NOT NULL CHECK (rounding_rule IN ('kopeck', 'ruble', 'ten_rubles')),
      early_payoff_discount_percent REAL NOT NULL DEFAULT 0 CHECK (early_payoff_discount_percent >= 0 AND early_payoff_discount_percent <= 100),
      is_active INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_history (
      id TEXT PRIMARY KEY,
      setting_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      old_value_json TEXT NOT NULL,
      new_value_json TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      changed_by TEXT,
      created_at TEXT NOT NULL
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
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Магазин электроники',
      contact_info TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      client_id TEXT REFERENCES clients(id),
      item_name TEXT NOT NULL,
      item_category TEXT NOT NULL DEFAULT 'Электроника',
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      purchase_price_kopecks INTEGER NOT NULL CHECK (purchase_price_kopecks >= 0),
      delivery_cost_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (delivery_cost_kopecks >= 0),
      other_cost_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (other_cost_kopecks >= 0),
      total_cost_kopecks INTEGER NOT NULL CHECK (total_cost_kopecks = purchase_price_kopecks + delivery_cost_kopecks + other_cost_kopecks),
      paid_to_supplier_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (paid_to_supplier_kopecks >= 0),
      supplier_debt_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (supplier_debt_kopecks >= 0),
      handover_status TEXT NOT NULL DEFAULT 'ready' CHECK (handover_status IN ('in_procurement', 'ready', 'handed_over', 'returned')),
      purchase_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      contract_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES clients(id),
      purchase_id TEXT REFERENCES purchases(id),
      plan_id TEXT REFERENCES installment_plans(id),
      plan_version INTEGER NOT NULL DEFAULT 1,
      item_title TEXT NOT NULL,
      purchase_cost_kopecks INTEGER NOT NULL CHECK (purchase_cost_kopecks >= 0),
      extra_cost_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_kopecks >= 0),
      total_cost_kopecks INTEGER NOT NULL CHECK (total_cost_kopecks = purchase_cost_kopecks + extra_cost_kopecks),
      markup_percent REAL NOT NULL CHECK (markup_percent >= 0),
      sale_price_kopecks INTEGER NOT NULL CHECK (sale_price_kopecks >= total_cost_kopecks),
      down_payment_percent REAL NOT NULL CHECK (down_payment_percent >= 0 AND down_payment_percent <= 100),
      down_payment_kopecks INTEGER NOT NULL CHECK (down_payment_kopecks >= 0 AND down_payment_kopecks <= sale_price_kopecks),
      financed_principal_kopecks INTEGER NOT NULL CHECK (financed_principal_kopecks = sale_price_kopecks - down_payment_kopecks),
      term_months INTEGER NOT NULL CHECK (term_months > 0),
      rounding_rule TEXT NOT NULL CHECK (rounding_rule IN ('kopeck', 'ruble', 'ten_rubles')),
      schedule_type TEXT NOT NULL DEFAULT 'equal' CHECK (schedule_type IN ('equal', 'custom')),
      start_date TEXT NOT NULL,
      current_schedule_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'restructured', 'returned', 'cancelled')),
      closing_discount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (closing_discount_kopecks >= 0),
      closed_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_versions (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      change_reason TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(contract_id, version)
    );

    CREATE TABLE IF NOT EXISTS schedule_items (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      schedule_version INTEGER NOT NULL,
      installment_number INTEGER NOT NULL CHECK (installment_number > 0),
      due_date TEXT NOT NULL,
      original_due_date TEXT NOT NULL,
      planned_kopecks INTEGER NOT NULL CHECK (planned_kopecks > 0),
      paid_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (paid_kopecks >= 0 AND paid_kopecks <= planned_kopecks),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'superseded', 'waived')),
      promised_date TEXT,
      postpone_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS overdue_contacts (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      schedule_item_id TEXT REFERENCES schedule_items(id),
      contact_channel TEXT NOT NULL CHECK (contact_channel IN ('phone', 'messenger', 'in_person')),
      summary TEXT NOT NULL,
      promised_date TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS financial_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('cash', 'bank')),
      balance_kopecks INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES clients(id),
      contract_id TEXT REFERENCES contracts(id),
      account_id TEXT NOT NULL REFERENCES financial_accounts(id),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer')),
      amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
      allocated_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (allocated_kopecks >= 0 AND allocated_kopecks <= amount_kopecks),
      unallocated_kopecks INTEGER NOT NULL CHECK (unallocated_kopecks = amount_kopecks - allocated_kopecks),
      is_down_payment INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed')),
      reversal_reason TEXT NOT NULL DEFAULT '',
      reversed_by TEXT,
      event_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id),
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      schedule_item_id TEXT NOT NULL REFERENCES schedule_items(id),
      amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
      created_by TEXT,
      created_at TEXT NOT NULL
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
      amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks > 0),
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT NOT NULL DEFAULT '',
      reversal_of_id TEXT REFERENCES ledger_entries(id),
      reversal_reason TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      event_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed')),
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('client', 'contract', 'purchase', 'payment', 'return')),
      entity_id TEXT NOT NULL,
      client_id TEXT,
      contract_id TEXT,
      doc_category TEXT NOT NULL CHECK (doc_category IN ('contract_scan', 'receipt', 'transfer_proof', 'handover_act', 'return_act', 'photo', 'generated_template')),
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
      sha256_hash TEXT NOT NULL,
      content_base64 TEXT NOT NULL DEFAULT '',
      previous_document_id TEXT,
      replaced_by_id TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_rules_config (
      id TEXT PRIMARY KEY,
      grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_period_days >= 0 AND grace_period_days <= 60),
      complex_min_overdue_days INTEGER NOT NULL DEFAULT 15 CHECK (complex_min_overdue_days >= 1 AND complex_min_overdue_days <= 365),
      complex_consecutive_missed_count INTEGER NOT NULL DEFAULT 2 CHECK (complex_consecutive_missed_count >= 1 AND complex_consecutive_missed_count <= 24),
      complex_min_overdue_kopecks INTEGER NOT NULL DEFAULT 3000000 CHECK (complex_min_overdue_kopecks >= 100),
      reliable_max_past_late_count INTEGER NOT NULL DEFAULT 3 CHECK (reliable_max_past_late_count >= 1 AND reliable_max_past_late_count <= 24),
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      sha256_hash TEXT NOT NULL,
      encrypted_alg TEXT NOT NULL DEFAULT 'AES-256-GCM',
      contracts_count INTEGER NOT NULL DEFAULT 0,
      ledger_net_kopecks INTEGER NOT NULL DEFAULT 0,
      verified_restore_at TEXT,
      status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'verified', 'failed')),
      created_by TEXT,
      created_at TEXT NOT NULL
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
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function recordMigration(db: DatabaseSync, version: string, description: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, description, applied_at)
    VALUES (?, ?, ?)
  `).run(version, description, new Date().toISOString());
}

/**
 * Ensures all uploaded contract photos/scans and documents are present BOTH in SQLite
 * (`documents.content_base64`) AND on disk (`PRIVATE_STORAGE_DIR` / `data/uploads`).
 * If a container update/redeploy wiped ephemeral disk folders, files are automatically
 * restored from the database. If legacy files exist on disk without `content_base64`,
 * they are automatically backed up into the database.
 */
export function syncDocumentsBetweenDbAndDisk(db: DatabaseSync): {
  restoredToDiskCount: number;
  backedUpToDbCount: number;
} {
  let restoredToDiskCount = 0;
  let backedUpToDbCount = 0;

  try {
    const uploadsDir =
      process.env.PRIVATE_STORAGE_DIR ||
      process.env.LOCAL_UPLOADS_DIR ||
      path.resolve(process.cwd(), 'data', 'uploads');
    const legacyUploadsDir = path.resolve(process.cwd(), 'uploads');

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
    }

    const docs = db
      .prepare('SELECT id, stored_filename, content_base64, sha256_hash FROM documents')
      .all() as Array<{
      id: string;
      stored_filename: string;
      content_base64: string;
      sha256_hash: string;
    }>;

    for (const doc of docs) {
      const safeName = path.basename(doc.stored_filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
      if (!safeName) continue;

      const targetPath = path.join(uploadsDir, safeName);
      const legacyPath = path.join(legacyUploadsDir, safeName);
      const existsInTarget = fs.existsSync(targetPath);
      const existsInLegacy = !existsInTarget && fs.existsSync(legacyPath);

      if (!existsInTarget && doc.content_base64) {
        // Restore missing physical file from DB content_base64
        const buf = Buffer.from(doc.content_base64, 'base64');
        fs.writeFileSync(targetPath, buf, { mode: 0o600 });
        restoredToDiskCount++;
      } else if (!existsInTarget && existsInLegacy) {
        // Copy from legacy ./uploads to persistent ./data/uploads and ensure DB has content_base64
        const buf = fs.readFileSync(legacyPath);
        fs.writeFileSync(targetPath, buf, { mode: 0o600 });
        restoredToDiskCount++;
        if (!doc.content_base64) {
          db.prepare('UPDATE documents SET content_base64 = ? WHERE id = ?').run(
            buf.toString('base64'),
            doc.id
          );
          backedUpToDbCount++;
        }
      } else if (existsInTarget && !doc.content_base64) {
        // Backfill DB content_base64 from physical file so DB is 100% self-contained
        const buf = fs.readFileSync(targetPath);
        db.prepare('UPDATE documents SET content_base64 = ? WHERE id = ?').run(
          buf.toString('base64'),
          doc.id
        );
        backedUpToDbCount++;
      }
    }
  } catch {
    // Non-fatal in restricted or in-memory test environments
  }

  return { restoredToDiskCount, backedUpToDbCount };
}

function migrateAuthSchemaIfNeeded(db: DatabaseSync): void {
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;');
  }
  if (!userColNames.has('password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT;');
  }

  const sessCols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const sessColNames = new Set(sessCols.map((c) => c.name));
  if (!sessColNames.has('last_active_at')) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_active_at TEXT NOT NULL DEFAULT '';");
  }

  const docCols = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
  const docColNames = new Set(docCols.map((c) => c.name));
  if (!docColNames.has('client_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN client_id TEXT;');
  }
  if (!docColNames.has('contract_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN contract_id TEXT;');
  }
  if (!docColNames.has('previous_document_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN previous_document_id TEXT;');
  }
  if (!docColNames.has('replaced_by_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN replaced_by_id TEXT;');
  }
  if (!docColNames.has('is_archived')) {
    db.exec('ALTER TABLE documents ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;');
  }

  // Backfill client_id / contract_id on existing documents if missing
  db.exec(`
    UPDATE documents
    SET contract_id = entity_id
    WHERE entity_type = 'contract' AND (contract_id IS NULL OR contract_id = '');
  `);
  db.exec(`
    UPDATE documents
    SET client_id = entity_id
    WHERE entity_type = 'client' AND (client_id IS NULL OR client_id = '');
  `);
  db.exec(`
    UPDATE documents
    SET client_id = (SELECT c.client_id FROM contracts c WHERE c.id = documents.contract_id)
    WHERE contract_id IS NOT NULL AND (client_id IS NULL OR client_id = '');
  `);

  const contractCols = db.prepare('PRAGMA table_info(contracts)').all() as Array<{ name: string }>;
  const contractColNames = new Set(contractCols.map((c) => c.name));
  if (!contractColNames.has('idempotency_key')) {
    db.exec('ALTER TABLE contracts ADD COLUMN idempotency_key TEXT;');
  }

  // Ensure default status_rules_config row exists without overwriting existing admin customizations
  const rulesRow = db
    .prepare("SELECT id FROM status_rules_config WHERE id = 'default'")
    .get() as { id: string } | undefined;
  if (!rulesRow) {
    db.prepare(`
      INSERT INTO status_rules_config (
        id, grace_period_days, complex_min_overdue_days,
        complex_consecutive_missed_count, complex_min_overdue_kopecks,
        reliable_max_past_late_count, updated_by, updated_at
      ) VALUES ('default', 0, 15, 2, 3000000, 3, 'system', ?)
    `).run(new Date().toISOString());
  }

  // Non-destructively normalize only legacy user phone numbers that are not yet in E.164 format (+7XXXXXXXXXX).
  // Never overwrite existing users' passwords, names, roles, or valid phone numbers on app updates.
  const existingUsers = db
    .prepare('SELECT id, email, phone, status FROM users')
    .all() as Array<{ id: string; email: string; phone: string; status: string }>;

  if (existingUsers.length > 0) {
    withTransaction(db, () => {
      let fallbackCounter = 10;
      for (const u of existingUsers) {
        const canonical = normalizeRussianPhone(u.phone);
        const isStatusValid = u.status === 'active' || u.status === 'blocked';
        if (canonical && canonical === u.phone && isStatusValid) {
          // Already valid — do not touch this user row
          continue;
        }
        let resolvedPhone = canonical;
        if (!resolvedPhone) {
          if (u.id === 'usr_owner_01') resolvedPhone = '+79285550101';
          else if (u.id === 'usr_staff_01') resolvedPhone = '+79285550102';
          else if (u.id === 'usr_pending_01') resolvedPhone = '+79285550109';
          else {
            resolvedPhone = `+792855501${String(fallbackCounter).padStart(2, '0')}`;
            fallbackCounter += 1;
          }
        }
        const nextStatus = isStatusValid ? u.status : 'blocked';
        db.prepare('UPDATE users SET phone = ?, status = ? WHERE id = ?').run(
          resolvedPhone,
          nextStatus,
          u.id
        );
      }
    });
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_contract ON documents(contract_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);');

  // Record applied non-destructive schema migrations
  recordMigration(db, '001_initial_schema', 'Базовая схема финансового учёта рассрочки');
  recordMigration(db, '002_auth_hardening', 'Защита сессий, rate-limiting и аудит безопасности');
  recordMigration(db, '003_phone_auth_rbac', 'Вход по номеру телефона и ролевая модель RBAC');
  recordMigration(
    db,
    '004_client_statuses_documents_whatsapp',
    'Статусы клиентов и договоров, версии документов, идемпотентность и WhatsApp'
  );
  recordMigration(
    db,
    '005_non_destructive_storage_sync',
    'Двойное хранение и автовосстановление фотографий и сканов договоров между БД и диском'
  );

  // Sync documents/photos between SQLite and disk so nothing is ever lost after updates
  syncDocumentsBetweenDbAndDisk(db);
}

function seedInitialDataIfEmpty(db: DatabaseSync): void {
  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (existingUsers.cnt > 0) {
    return;
  }

  const seedDemoData = process.env.SEED_DEMO_DATA !== 'false';

  withTransaction(db, () => {
    const now = '2026-10-28T08:00:00.000Z';
    const ownerId = 'usr_owner_01';
    const staffId = 'usr_staff_01';
    const blockedId = 'usr_pending_01';

    // Default initial users (canonical E.164 phone numbers +7XXXXXXXXXX)
    const insertUser = db.prepare(`
      INSERT INTO users (
        id, email, full_name, phone, password_hash, role, status,
        must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const initialOwnerPhone = normalizeRussianPhone(process.env.INITIAL_ADMIN_PHONE || '+79285550101') || '+79285550101';
    const initialOwnerPass = process.env.INITIAL_ADMIN_PASSWORD || 'MoOwner!2026';
    const initialOwnerName = process.env.INITIAL_ADMIN_NAME || 'Мо (Владелец)';

    insertUser.run(
      ownerId,
      'mo@rassrochka.ru',
      initialOwnerName,
      initialOwnerPhone,
      hashPassword(initialOwnerPass),
      'owner',
      'active',
      0,
      now,
      0,
      ownerId,
      now,
      now
    );

    if (seedDemoData) {
      insertUser.run(
        staffId,
        'diana@rassrochka.ru',
        'Исмаилова Диана Тимуровна (Оператор)',
        '+79285550102',
        hashPassword('StaffPass!2026'),
        'staff',
        'active',
        0,
        now,
        0,
        ownerId,
        now,
        now
      );

      insertUser.run(
        blockedId,
        'blocked.user@rassrochka.local',
        'Магомедов Тимур Алиевич',
        '+79285550109',
        hashPassword('BlockedPass!2026'),
        'readonly',
        'blocked',
        1,
        null,
        0,
        ownerId,
        now,
        now
      );
    }

    // Default configurable installment plans (Section 4 requirements: 6m -> 25%, 12m -> 33%, 30% down payment)
    const insertPlan = db.prepare(`
      INSERT INTO installment_plans (
        id, name, term_months, markup_percent, down_payment_percent,
        down_payment_required, rounding_rule, early_payoff_discount_percent,
        is_active, version, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertPlan.run(
      'plan_6m_std',
      'Стандарт 6 месяцев',
      6,
      25,
      30,
      1,
      'kopeck',
      30,
      1,
      1,
      ownerId,
      now,
      now
    );

    insertPlan.run(
      'plan_12m_std',
      'Стандарт 12 месяцев',
      12,
      33,
      30,
      1,
      'kopeck',
      35,
      1,
      1,
      ownerId,
      now,
      now
    );

    insertPlan.run(
      'plan_3m_fast',
      'Короткий 3 месяца',
      3,
      15,
      30,
      1,
      'ruble',
      20,
      1,
      1,
      ownerId,
      now,
      now
    );

    // Financial accounts (Cash & Bank)
    const insertAccount = db.prepare(`
      INSERT INTO financial_accounts (id, name, account_type, balance_kopecks, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    insertAccount.run('acc_cash_main', 'Основная касса (Наличные ₽)', 'cash', 0, now);
    insertAccount.run('acc_bank_main', 'Расчётный счёт / Переводы (Банк ₽)', 'bank', 0, now);

    if (!seedDemoData) {
      db.prepare(`
        INSERT INTO audit_logs (id, actor_user_id, actor_email, action, entity_type, entity_id, summary, metadata_json, created_at)
        VALUES (?, ?, ?, 'SYSTEM_INITIALIZED_CLEAN', 'system', 'root', ?, '{}', ?)
      `).run(
        crypto.randomUUID(),
        ownerId,
        initialOwnerPhone,
        'Инициализирована чистая рабочая база данных без демонстрационных записей (SEED_DEMO_DATA=false).',
        now
      );
      return;
    }

    // Owner capital injection so cash/bank registers are grounded in real ledger operations
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, idempotency_key, account_id, related_account_id, entry_type, category,
        direction, amount_kopecks, reference_type, reference_id, description,
        event_date, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
    `);
    const updateAccountBalance = db.prepare(`
      UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?
    `);

    // 350 000,00 ₽ into Bank + 150 000,00 ₽ into Cash as initial owner capital
    insertLedger.run(
      'led_init_bank',
      'idem_init_owner_bank',
      'acc_bank_main',
      null,
      'owner_injection',
      'Собственные средства владельца',
      'in',
      35000000,
      'owner_capital',
      ownerId,
      'Начальное пополнение оборотного капитала собственными средствами владельца (безнал)',
      '2026-07-01',
      ownerId,
      now
    );
    updateAccountBalance.run(35000000, 'acc_bank_main');

    insertLedger.run(
      'led_init_cash',
      'idem_init_owner_cash',
      'acc_cash_main',
      null,
      'owner_injection',
      'Собственные средства владельца',
      'in',
      15000000,
      'owner_capital',
      ownerId,
      'Начальное внесение собственных наличных средств владельца в кассу',
      '2026-07-01',
      ownerId,
      now
    );
    updateAccountBalance.run(15000000, 'acc_cash_main');

    // Suppliers
    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (id, name, category, contact_info, notes, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    insertSupplier.run(
      'sup_dns_01',
      'DNS Ритейл (ТЦ Этажи)',
      'Магазин электроники и техники',
      '+7 (800) 770-79-99, отдел корпоративных и розничных продаж',
      'Выдача кассовых и товарных чеков в день покупки',
      now
    );
    insertSupplier.run(
      'sup_mvideo_02',
      'М.Видео / Эльдорадо',
      'Бытовая техника и смартфоны',
      '+7 (800) 600-77-75, пр-т Гамзатова, 42',
      'Бытовая техника и крупногабаритные товары с доставкой',
      now
    );

    // Clients
    const insertClient = db.prepare(`
      INSERT INTO clients (id, full_name, phone, secondary_phone, document_ref, address, notes, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);
    insertClient.run(
      'cli_01',
      'Гаджиев Марат Русланович',
      '+7 (928) 701-44-12',
      '+7 (988) 210-11-00',
      'Паспорт РФ серия 82 14 № ***481 (проверен лично)',
      'г. Махачкала, ул. Коркмасова, д. 18, кв. 41',
      'Постоянный клиент, предпочитает оплату переводом 15-го числа',
      ownerId,
      now
    );
    insertClient.run(
      'cli_02',
      'Алиева Зарема Камильевна',
      '+7 (963) 412-88-35',
      '',
      'Паспорт РФ серия 82 16 № ***902 (проверен лично)',
      'г. Каспийск, ул. Ленина, д. 34, кв. 12',
      'Приобретение бытовой техники для дома',
      ownerId,
      now
    );

    // Purchases & Contracts
    const insertPurchase = db.prepare(`
      INSERT INTO purchases (
        id, supplier_id, client_id, item_name, item_category, quantity,
        purchase_price_kopecks, delivery_cost_kopecks, other_cost_kopecks,
        total_cost_kopecks, paid_to_supplier_kopecks, supplier_debt_kopecks,
        handover_status, purchase_date, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Purchase 1: iPhone 16 Pro 256GB (80 000 ₽ purchase + 1 200 ₽ delivery = 81 200 ₽ total cost)
    insertPurchase.run(
      'pur_01',
      'sup_dns_01',
      'cli_01',
      'Смартфон Apple iPhone 16 Pro 256GB Natural Titanium',
      'Смартфоны',
      1,
      8000000,
      120000,
      0,
      8120000,
      8000000,
      0,
      'handed_over',
      '2026-08-15',
      'Кассовый чек №48192 от 15.08.2026, курьерская доставка до офиса',
      ownerId,
      now
    );

    // Ledger outflow for purchase 1 + delivery
    insertLedger.run(
      'led_pur_01',
      'idem_pur_01_cost',
      'acc_bank_main',
      null,
      'purchase_payment',
      'Закупка товара под клиента',
      'out',
      8000000,
      'purchase',
      'pur_01',
      'Оплата поставщику DNS Ритейл за Apple iPhone 16 Pro 256GB',
      '2026-08-15',
      ownerId,
      now
    );
    updateAccountBalance.run(-8000000, 'acc_bank_main');

    insertLedger.run(
      'led_del_01',
      'idem_pur_01_delivery',
      'acc_cash_main',
      null,
      'delivery_expense',
      'Доставка товара',
      'out',
      120000,
      'purchase',
      'pur_01',
      'Оплата доставки Apple iPhone 16 Pro 256GB',
      '2026-08-15',
      ownerId,
      now
    );
    updateAccountBalance.run(-120000, 'acc_cash_main');

    // Contract 1 calculation: 81 200 ₽ * 1.25 = 101 500 ₽, down payment 30% = 30 450 ₽, balance = 71 050 ₽ over 6 months
    const calc1 = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 120000,
      otherCostKopecks: 0,
      markupPercent: 25,
      downPaymentPercent: 30,
      termMonths: 6,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-08-15',
    });

    const insertContract = db.prepare(`
      INSERT INTO contracts (
        id, contract_number, client_id, purchase_id, plan_id, plan_version,
        item_title, purchase_cost_kopecks, extra_cost_kopecks, total_cost_kopecks,
        markup_percent, sale_price_kopecks, down_payment_percent, down_payment_kopecks,
        financed_principal_kopecks, term_months, rounding_rule, schedule_type,
        start_date, current_schedule_version, status, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)
    `);

    insertContract.run(
      'cnt_01',
      'ДГ-2026-0001',
      'cli_01',
      'pur_01',
      'plan_6m_std',
      1,
      'Смартфон Apple iPhone 16 Pro 256GB Natural Titanium',
      calc1.purchaseCostKopecks,
      calc1.deliveryCostKopecks + calc1.otherCostKopecks,
      calc1.totalCostKopecks,
      calc1.markupPercent,
      calc1.salePriceKopecks,
      calc1.downPaymentPercent,
      calc1.downPaymentKopecks,
      calc1.financedPrincipalKopecks,
      calc1.termMonths,
      calc1.roundingRule,
      calc1.scheduleType,
      '2026-08-15',
      'Стандартный договор на 6 месяцев (25% наценка, 30% первый взнос)',
      ownerId,
      now
    );

    const insertSchedVersion = db.prepare(`
      INSERT INTO schedule_versions (id, contract_id, version, change_reason, created_by, created_at)
      VALUES (?, ?, 1, 'Первоначальный график при оформлении договора', ?, ?)
    `);
    insertSchedVersion.run('sv_cnt_01_v1', 'cnt_01', ownerId, now);

    const insertSchedItem = db.prepare(`
      INSERT INTO schedule_items (
        id, contract_id, schedule_version, installment_number, due_date,
        original_due_date, planned_kopecks, paid_kopecks, status, promised_date, postpone_reason
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, '')
    `);

    for (const item of calc1.schedule) {
      const itemId = `si_cnt_01_${item.installmentNumber}`;
      const isFirstPaid = item.installmentNumber === 1;
      const isSecondOverduePartial = item.installmentNumber === 2;
      const paidKop = isFirstPaid ? item.plannedKopecks : isSecondOverduePartial ? 500000 : 0;
      const status = isFirstPaid ? 'paid' : isSecondOverduePartial ? 'overdue' : 'pending';
      const promisedDate = isSecondOverduePartial ? '2026-10-31' : null;

      insertSchedItem.run(
        itemId,
        'cnt_01',
        item.installmentNumber,
        item.dueDate,
        item.dueDate,
        item.plannedKopecks,
        paidKop,
        status,
        promisedDate
      );
    }

    // Record down payment + 1st installment + partial 2nd installment for Contract 1
    const insertPayment = db.prepare(`
      INSERT INTO payments (
        id, idempotency_key, client_id, contract_id, account_id, payment_method,
        amount_kopecks, allocated_kopecks, unallocated_kopecks, is_down_payment,
        status, event_date, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
    `);

    // Down payment 30 450,00 ₽
    insertPayment.run(
      'pay_dp_01',
      'idem_pay_dp_01',
      'cli_01',
      'cnt_01',
      'acc_cash_main',
      'cash',
      calc1.downPaymentKopecks,
      calc1.downPaymentKopecks,
      0,
      1,
      '2026-08-15',
      'Первоначальный взнос 30% по договору ДГ-2026-0001',
      ownerId,
      now
    );
    insertLedger.run(
      'led_pay_dp_01',
      'idem_led_pay_dp_01',
      'acc_cash_main',
      null,
      'client_payment',
      'Первоначальный взнос клиента',
      'in',
      calc1.downPaymentKopecks,
      'payment',
      'pay_dp_01',
      'Первоначальный взнос по договору ДГ-2026-0001 (Гаджиев М.Р.)',
      '2026-08-15',
      ownerId,
      now
    );
    updateAccountBalance.run(calc1.downPaymentKopecks, 'acc_cash_main');

    // First scheduled installment + partial 2nd installment
    const firstItemKop = calc1.schedule[0].plannedKopecks;
    const combinedTransferKop = firstItemKop + 500000;
    insertPayment.run(
      'pay_inst_01',
      'idem_pay_inst_01',
      'cli_01',
      'cnt_01',
      'acc_bank_main',
      'bank_transfer',
      combinedTransferKop,
      combinedTransferKop,
      0,
      0,
      '2026-09-15',
      'Платёж по графику №1 полностью и частичная оплата платежа №2',
      ownerId,
      now
    );
    insertLedger.run(
      'led_pay_inst_01',
      'idem_led_pay_inst_01',
      'acc_bank_main',
      null,
      'client_payment',
      'Погашение по графику рассрочки',
      'in',
      combinedTransferKop,
      'payment',
      'pay_inst_01',
      'Поступление от клиента по договору ДГ-2026-0001 (Гаджиев М.Р.)',
      '2026-09-15',
      ownerId,
      now
    );
    updateAccountBalance.run(combinedTransferKop, 'acc_bank_main');

    const insertAlloc = db.prepare(`
      INSERT INTO payment_allocations (id, payment_id, contract_id, schedule_item_id, amount_kopecks, status, created_by, created_at)
      VALUES (?, ?, 'cnt_01', ?, ?, 'active', ?, ?)
    `);
    insertAlloc.run('alloc_01', 'pay_inst_01', 'si_cnt_01_1', firstItemKop, ownerId, now);
    insertAlloc.run('alloc_02', 'pay_inst_01', 'si_cnt_01_2', 500000, ownerId, now);

    // Overdue contact log for installment #2
    db.prepare(`
      INSERT INTO overdue_contacts (id, contract_id, schedule_item_id, contact_channel, summary, promised_date, created_by, created_at)
      VALUES (?, 'cnt_01', 'si_cnt_01_2', 'phone', ?, '2026-10-31', ?, ?)
    `).run(
      'oc_01',
      'Связались с клиентом по телефону. Оплатил 5 000 ₽, оставшуюся часть по 2-му платежу попросил перенести до 31.10.2026 без штрафов.',
      ownerId,
      now
    );

    // Purchase 2 & Contract 2 (12 months, 33% markup, with an unallocated payment ready for manual allocation)
    insertPurchase.run(
      'pur_02',
      'sup_mvideo_02',
      'cli_02',
      'Холодильник LG DoorCooling+ GA-B509 (Бежевый)',
      'Бытовая техника',
      1,
      5800000,
      200000,
      0,
      6000000,
      4500000,
      1300000, // 13 000 ₽ remaining obligation to supplier M.Video
      'handed_over',
      '2026-09-25',
      'Оплачено поставщику 45 000 ₽, остаток 13 000 ₽ по счёту поставщика до 10.11.2026',
      ownerId,
      now
    );

    insertLedger.run(
      'led_pur_02',
      'idem_pur_02_cost',
      'acc_bank_main',
      null,
      'purchase_payment',
      'Закупка товара под клиента',
      'out',
      4500000,
      'purchase',
      'pur_02',
      'Частичная оплата поставщику М.Видео за холодильник LG GA-B509',
      '2026-09-25',
      ownerId,
      now
    );
    updateAccountBalance.run(-4500000, 'acc_bank_main');

    insertLedger.run(
      'led_del_02',
      'idem_pur_02_delivery',
      'acc_cash_main',
      null,
      'delivery_expense',
      'Доставка товара',
      'out',
      200000,
      'purchase',
      'pur_02',
      'Доставка и подъём на этаж холодильника LG GA-B509',
      '2026-09-25',
      ownerId,
      now
    );
    updateAccountBalance.run(-200000, 'acc_cash_main');

    const calc2 = calculateContractAndSchedule({
      purchaseCostKopecks: 5800000,
      deliveryCostKopecks: 200000,
      otherCostKopecks: 0,
      markupPercent: 33,
      downPaymentPercent: 30,
      termMonths: 12,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-09-25',
    });

    insertContract.run(
      'cnt_02',
      'ДГ-2026-0002',
      'cli_02',
      'pur_02',
      'plan_12m_std',
      1,
      'Холодильник LG DoorCooling+ GA-B509 (Бежевый)',
      calc2.purchaseCostKopecks,
      calc2.deliveryCostKopecks + calc2.otherCostKopecks,
      calc2.totalCostKopecks,
      calc2.markupPercent,
      calc2.salePriceKopecks,
      calc2.downPaymentPercent,
      calc2.downPaymentKopecks,
      calc2.financedPrincipalKopecks,
      calc2.termMonths,
      calc2.roundingRule,
      calc2.scheduleType,
      '2026-09-25',
      'Договор на 12 месяцев (33% наценка, 30% первоначальный взнос)',
      ownerId,
      now
    );

    insertSchedVersion.run('sv_cnt_02_v1', 'cnt_02', ownerId, now);

    for (const item of calc2.schedule) {
      insertSchedItem.run(
        `si_cnt_02_${item.installmentNumber}`,
        'cnt_02',
        item.installmentNumber,
        item.dueDate,
        item.dueDate,
        item.plannedKopecks,
        0,
        item.dueDate < '2026-10-28' ? 'overdue' : 'pending',
        null
      );
    }

    // Down payment for Contract 2
    insertPayment.run(
      'pay_dp_02',
      'idem_pay_dp_02',
      'cli_02',
      'cnt_02',
      'acc_cash_main',
      'cash',
      calc2.downPaymentKopecks,
      calc2.downPaymentKopecks,
      0,
      1,
      '2026-09-25',
      'Первоначальный взнос 30% по договору ДГ-2026-0002',
      ownerId,
      now
    );
    insertLedger.run(
      'led_pay_dp_02',
      'idem_led_pay_dp_02',
      'acc_cash_main',
      null,
      'client_payment',
      'Первоначальный взнос клиента',
      'in',
      calc2.downPaymentKopecks,
      'payment',
      'pay_dp_02',
      'Первоначальный взнос по договору ДГ-2026-0002 (Алиева З.К.)',
      '2026-09-25',
      ownerId,
      now
    );
    updateAccountBalance.run(calc2.downPaymentKopecks, 'acc_cash_main');

    // Unallocated bank transfer from Aliyeva Z.K. (6 000,00 ₽) awaiting manual owner allocation!
    insertPayment.run(
      'pay_unalloc_02',
      'idem_pay_unalloc_02',
      'cli_02',
      null,
      'acc_bank_main',
      'bank_transfer',
      600000,
      0,
      600000,
      0,
      '2026-10-26',
      'Перевод по СБП от Алиевой З.К. без указания номера договора — ожидает ручного распределения владельцем',
      staffId,
      now
    );
    insertLedger.run(
      'led_pay_unalloc_02',
      'idem_led_pay_unalloc_02',
      'acc_bank_main',
      null,
      'client_payment',
      'Нераспределённое поступление от клиента',
      'in',
      600000,
      'payment',
      'pay_unalloc_02',
      'Поступление 6 000,00 ₽ от Алиевой З.К. (ожидает ручного распределения по графику)',
      '2026-10-26',
      staffId,
      now
    );
    updateAccountBalance.run(600000, 'acc_bank_main');

    // Operating expense example (Rent / Office)
    insertLedger.run(
      'led_exp_office',
      'idem_led_exp_office',
      'acc_bank_main',
      null,
      'operating_expense',
      'Аренда офиса и связь',
      'out',
      1500000,
      'expense',
      'exp_01',
      'Оплата аренды клиентского офиса и связи за октябрь 2026',
      '2026-10-05',
      ownerId,
      now
    );
    updateAccountBalance.run(-1500000, 'acc_bank_main');

    // Initial Audit entry
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, actor_email, action, entity_type, entity_id, summary, metadata_json, created_at)
      VALUES (?, ?, ?, 'SYSTEM_INITIALIZED', 'system', 'root', ?, '{}', ?)
    `).run(
      crypto.randomUUID(),
      ownerId,
      'owner@rassrochka.local',
      'Инициализирована база данных с настройками рассрочки (6 мес / 25%, 12 мес / 33%, взнос 30%) и проверочными регистрами.',
      now
    );
  });
}

export interface DatabaseInventoryReport {
  inspectedAt: string;
  tableCounts: Record<string, number>;
  users: Array<{ id: string; phone: string; full_name: string; role: string; status: string }>;
  clients: Array<{ id: string; full_name: string; phone: string }>;
  contracts: Array<{ id: string; contract_number: string; item_title: string; status: string }>;
  financialAccounts: Array<{ id: string; name: string; account_type: string; balance_kopecks: number }>;
}

export function inspectDatabaseRecords(db: DatabaseSync): DatabaseInventoryReport {
  const tableNames = [
    'users',
    'sessions',
    'auth_rate_limits',
    'installment_plans',
    'settings_history',
    'clients',
    'suppliers',
    'purchases',
    'contracts',
    'schedule_versions',
    'schedule_items',
    'overdue_contacts',
    'financial_accounts',
    'payments',
    'payment_allocations',
    'ledger_entries',
    'documents',
    'backups',
    'audit_logs',
  ];

  const tableCounts: Record<string, number> = {};
  for (const tbl of tableNames) {
    const r = db.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number };
    tableCounts[tbl] = r.cnt;
  }

  const users = db
    .prepare('SELECT id, phone, full_name, role, status FROM users ORDER BY created_at ASC')
    .all() as Array<{ id: string; phone: string; full_name: string; role: string; status: string }>;

  const clients = db
    .prepare('SELECT id, full_name, phone FROM clients ORDER BY created_at ASC')
    .all() as Array<{ id: string; full_name: string; phone: string }>;

  const contracts = db
    .prepare('SELECT id, contract_number, item_title, status FROM contracts ORDER BY created_at ASC')
    .all() as Array<{ id: string; contract_number: string; item_title: string; status: string }>;

  const financialAccounts = db
    .prepare('SELECT id, name, account_type, balance_kopecks FROM financial_accounts ORDER BY id ASC')
    .all() as Array<{ id: string; name: string; account_type: string; balance_kopecks: number }>;

  return {
    inspectedAt: new Date().toISOString(),
    tableCounts,
    users,
    clients,
    contracts,
    financialAccounts,
  };
}

export function cleanResetOperationalData(
  db: DatabaseSync,
  actorUserId: string,
  actorIdentifier: string,
  options?: { keepStaffUsers?: boolean }
): {
  deletedCounts: Record<string, number>;
  preservedUsers: number;
  preservedPlans: number;
  resetAccountsCount: number;
} {
  const before = inspectDatabaseRecords(db);
  const keepStaff = options?.keepStaffUsers ?? false;

  withTransaction(db, () => {
    db.exec('DELETE FROM payment_allocations;');
    db.exec('DELETE FROM payments;');
    db.exec('DELETE FROM ledger_entries;');
    db.exec('DELETE FROM overdue_contacts;');
    db.exec('DELETE FROM schedule_items;');
    db.exec('DELETE FROM schedule_versions;');
    db.exec('DELETE FROM contracts;');
    db.exec('DELETE FROM purchases;');
    db.exec('DELETE FROM suppliers;');
    db.exec('DELETE FROM clients;');
    db.exec('DELETE FROM documents;');
    db.exec('DELETE FROM auth_rate_limits;');
    db.exec('DELETE FROM verification_codes;');

    // Reset financial account balances to 0 kopecks so registers match empty ledger_entries
    db.exec('UPDATE financial_accounts SET balance_kopecks = 0;');

    if (!keepStaff) {
      // Remove demo blocked/staff accounts while strictly keeping active owner(s)
      db.exec("DELETE FROM users WHERE role != 'owner';");
    }

    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, actor_email, action, entity_type, entity_id, summary, metadata_json, created_at)
      VALUES (?, ?, ?, 'DATABASE_CLEAN_RESET', 'system', 'root', ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      actorUserId,
      actorIdentifier,
      'Выполнена контролируемая очистка демонстрационных и операционных данных для чистого старта в эксплуатации.',
      JSON.stringify({ beforeCounts: before.tableCounts }),
      new Date().toISOString()
    );
  });

  const after = inspectDatabaseRecords(db);
  const deletedCounts: Record<string, number> = {};
  for (const key of Object.keys(before.tableCounts)) {
    const diff = before.tableCounts[key] - (after.tableCounts[key] || 0);
    if (diff > 0) {
      deletedCounts[key] = diff;
    }
  }

  return {
    deletedCounts,
    preservedUsers: after.tableCounts.users,
    preservedPlans: after.tableCounts.installment_plans,
    resetAccountsCount: after.tableCounts.financial_accounts,
  };
}

