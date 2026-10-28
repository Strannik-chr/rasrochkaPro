import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ReconciliationResultDTO } from '../../shared/types';
import { decryptBackupPayload, encryptBackupPayload } from '../security/crypto';

export function recordAudit(
  db: DatabaseSync,
  params: {
    actorUserId: string | null;
    actorEmail: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }
): void {
  const safeMeta = JSON.stringify(params.metadata || {});
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_email, action, entity_type, entity_id, summary, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.actorUserId,
    params.actorEmail,
    params.action,
    params.entityType,
    params.entityId,
    params.summary,
    safeMeta,
    new Date().toISOString()
  );
}

export function reconcileFinance(db: DatabaseSync): ReconciliationResultDTO {
  const discrepancies: string[] = [];

  // 1. Check each financial account balance vs confirmed ledger entries
  const accounts = db
    .prepare('SELECT id, name, balance_kopecks FROM financial_accounts')
    .all() as Array<{ id: string; name: string; balance_kopecks: number }>;

  let totalCashAndBankKopecks = 0;
  let calculatedLedgerBalanceKopecks = 0;
  let accountsConsistent = true;

  for (const acc of accounts) {
    totalCashAndBankKopecks += acc.balance_kopecks;
    const ledgerRow = db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_kopecks ELSE -amount_kopecks END), 0) as net_kopecks
        FROM ledger_entries
        WHERE account_id = ? AND status = 'confirmed'
      `
      )
      .get(acc.id) as { net_kopecks: number };

    calculatedLedgerBalanceKopecks += ledgerRow.net_kopecks;
    if (acc.balance_kopecks !== ledgerRow.net_kopecks) {
      accountsConsistent = false;
      discrepancies.push(
        `Несоответствие баланса счёта «${acc.name}»: в регистре ${acc.balance_kopecks} коп., по проводкам ${ledgerRow.net_kopecks} коп.`
      );
    }
  }

  // 2. Check payments allocation invariant: allocated_kopecks + unallocated_kopecks === amount_kopecks
  const payments = db
    .prepare(
      `
      SELECT id, amount_kopecks, allocated_kopecks, unallocated_kopecks, is_down_payment, status
      FROM payments
      WHERE status = 'confirmed'
    `
    )
    .all() as Array<{
    id: string;
    amount_kopecks: number;
    allocated_kopecks: number;
    unallocated_kopecks: number;
    is_down_payment: number;
    status: string;
  }>;

  let paymentsConsistent = true;
  for (const pay of payments) {
    if (pay.allocated_kopecks + pay.unallocated_kopecks !== pay.amount_kopecks) {
      paymentsConsistent = false;
      discrepancies.push(`Платёж ${pay.id}: нарушена сумма распределённого и нераспределённого остатка.`);
    }
    if (!pay.is_down_payment) {
      const allocRow = db
        .prepare(
          `
          SELECT COALESCE(SUM(amount_kopecks), 0) as sum_alloc
          FROM payment_allocations
          WHERE payment_id = ? AND status = 'active'
        `
        )
        .get(pay.id) as { sum_alloc: number };

      if (allocRow.sum_alloc !== pay.allocated_kopecks) {
        paymentsConsistent = false;
        discrepancies.push(
          `Платёж ${pay.id}: allocated_kopecks (${pay.allocated_kopecks}) не равен сумме строк payment_allocations (${allocRow.sum_alloc}).`
        );
      }
    }
  }

  // 3. Check schedule items invariant for active version of contracts
  const contracts = db
    .prepare(
      `
      SELECT id, contract_number, financed_principal_kopecks, closing_discount_kopecks, current_schedule_version, status
      FROM contracts
      WHERE status IN ('active', 'completed', 'restructured')
    `
    )
    .all() as Array<{
    id: string;
    contract_number: string;
    financed_principal_kopecks: number;
    closing_discount_kopecks: number;
    current_schedule_version: number;
    status: string;
  }>;

  let schedulesConsistent = true;
  for (const c of contracts) {
    const schedSum = db
      .prepare(
        `
        SELECT COALESCE(SUM(planned_kopecks), 0) as total_planned
        FROM schedule_items
        WHERE contract_id = ? AND schedule_version = ?
      `
      )
      .get(c.id, c.current_schedule_version) as { total_planned: number };

    const expectedPrincipal = c.financed_principal_kopecks - c.closing_discount_kopecks;
    if (schedSum.total_planned !== expectedPrincipal && schedSum.total_planned !== c.financed_principal_kopecks) {
      schedulesConsistent = false;
      discrepancies.push(
        `Договор ${c.contract_number}: сумма текущего графика (${schedSum.total_planned} коп.) не совпадает с остатком по договору (${expectedPrincipal} коп.).`
      );
    }
  }

  return {
    isHealthy: accountsConsistent && paymentsConsistent && schedulesConsistent && discrepancies.length === 0,
    checkedAt: new Date().toISOString(),
    accountsConsistent,
    paymentsConsistent,
    schedulesConsistent,
    totalCashAndBankKopecks,
    calculatedLedgerBalanceKopecks,
    discrepancies,
  };
}

export function createEncryptedBackup(
  db: DatabaseSync,
  actorUserId: string,
  actorEmail: string
): {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256Hash: string;
  contractsCount: number;
  ledgerNetKopecks: number;
} {
  const backupDir = path.resolve(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const reconciliation = reconcileFinance(db);
  if (!reconciliation.isHealthy) {
    throw new Error(
      `Создание резервной копии остановлено: обнаружены расхождения регистров (${reconciliation.discrepancies.join('; ')})`
    );
  }

  const snapshot = {
    createdAt: new Date().toISOString(),
    reconciliation,
    tables: {
      users: db
        .prepare(
          'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, created_at FROM users'
        )
        .all(),
      installment_plans: db.prepare('SELECT * FROM installment_plans').all(),
      settings_history: db.prepare('SELECT * FROM settings_history').all(),
      clients: db.prepare('SELECT * FROM clients').all(),
      suppliers: db.prepare('SELECT * FROM suppliers').all(),
      purchases: db.prepare('SELECT * FROM purchases').all(),
      contracts: db.prepare('SELECT * FROM contracts').all(),
      schedule_versions: db.prepare('SELECT * FROM schedule_versions').all(),
      schedule_items: db.prepare('SELECT * FROM schedule_items').all(),
      overdue_contacts: db.prepare('SELECT * FROM overdue_contacts').all(),
      financial_accounts: db.prepare('SELECT * FROM financial_accounts').all(),
      payments: db.prepare('SELECT * FROM payments').all(),
      payment_allocations: db.prepare('SELECT * FROM payment_allocations').all(),
      ledger_entries: db.prepare('SELECT * FROM ledger_entries').all(),
      documents: db
        .prepare(
          'SELECT id, entity_type, entity_id, doc_category, title, original_filename, stored_filename, mime_type, size_bytes, sha256_hash, created_at FROM documents'
        )
        .all(),
    },
  };

  const plaintext = JSON.stringify(snapshot);
  const encrypted = encryptBackupPayload(plaintext);
  const envelopeJson = JSON.stringify(encrypted, null, 2);

  const id = `bkp_${crypto.randomUUID().slice(0, 8)}`;
  const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup_${timestampSlug}_${id}.enc.json`;
  const filePath = path.join(backupDir, filename);

  fs.writeFileSync(filePath, envelopeJson, { encoding: 'utf8', mode: 0o600 });
  const sizeBytes = Buffer.byteLength(envelopeJson, 'utf8');
  const contractsCount = snapshot.tables.contracts.length;
  const ledgerNetKopecks = reconciliation.totalCashAndBankKopecks;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO backups (
      id, filename, size_bytes, sha256_hash, encrypted_alg,
      contracts_count, ledger_net_kopecks, verified_restore_at, status, created_by, created_at
    ) VALUES (?, ?, ?, ?, 'AES-256-GCM', ?, ?, NULL, 'created', ?, ?)
  `).run(id, filename, sizeBytes, encrypted.sha256Hash, contractsCount, ledgerNetKopecks, actorUserId, now);

  recordAudit(db, {
    actorUserId,
    actorEmail,
    action: 'BACKUP_CREATED',
    entityType: 'backup',
    entityId: id,
    summary: `Создана зашифрованная резервная копия ${filename} (AES-256-GCM, SHA-256: ${encrypted.sha256Hash.slice(0, 12)}...)`,
  });

  return {
    id,
    filename,
    sizeBytes,
    sha256Hash: encrypted.sha256Hash,
    contractsCount,
    ledgerNetKopecks,
  };
}

export function verifyEncryptedBackup(
  db: DatabaseSync,
  backupId: string,
  actorUserId: string,
  actorEmail: string
): {
  verified: boolean;
  sha256Hash: string;
  contractsCount: number;
  ledgerNetKopecks: number;
  verifiedAt: string;
} {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as
    | {
        id: string;
        filename: string;
        sha256_hash: string;
      }
    | undefined;

  if (!row) {
    throw new Error('Резервная копия не найдена.');
  }

  const filePath = path.resolve(process.cwd(), 'backups', path.basename(row.filename));
  if (!fs.existsSync(filePath)) {
    throw new Error('Файл резервной копии отсутствует на диске.');
  }

  const envelopeRaw = fs.readFileSync(filePath, 'utf8');
  const envelope = JSON.parse(envelopeRaw) as {
    ciphertextBase64: string;
    ivHex: string;
    authTagHex: string;
    sha256Hash: string;
  };

  const decryptedJson = decryptBackupPayload(envelope);
  const parsed = JSON.parse(decryptedJson) as {
    reconciliation: ReconciliationResultDTO;
    tables: { contracts: unknown[] };
  };

  if (!parsed.reconciliation || !parsed.reconciliation.isHealthy) {
    throw new Error('Внутри резервной копии обнаружена ошибка целостности регистров.');
  }

  const verifiedAt = new Date().toISOString();
  db.prepare(`
    UPDATE backups SET verified_restore_at = ?, status = 'verified' WHERE id = ?
  `).run(verifiedAt, backupId);

  recordAudit(db, {
    actorUserId,
    actorEmail,
    action: 'BACKUP_RESTORE_VERIFIED',
    entityType: 'backup',
    entityId: backupId,
    summary: `Успешно проверено тестовое восстановление и расшифровка копии ${row.filename} (SHA-256 совпал, регистры сходятся).`,
  });

  return {
    verified: true,
    sha256Hash: envelope.sha256Hash,
    contractsCount: parsed.tables.contracts.length,
    ledgerNetKopecks: parsed.reconciliation.totalCashAndBankKopecks,
    verifiedAt,
  };
}

export function getBackupEnvelopeFile(
  db: DatabaseSync,
  backupId: string
): { filename: string; content: string; sha256Hash: string } {
  const row = db.prepare('SELECT id, filename, sha256_hash FROM backups WHERE id = ?').get(backupId) as
    | { id: string; filename: string; sha256_hash: string }
    | undefined;

  if (!row) {
    throw new Error('Резервная копия не найдена.');
  }

  const safeFilename = path.basename(row.filename);
  const filePath = path.resolve(process.cwd(), 'backups', safeFilename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Файл резервной копии отсутствует на диске.');
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return {
    filename: safeFilename,
    content,
    sha256Hash: row.sha256_hash,
  };
}

export function restoreEncryptedBackupFromEnvelope(
  db: DatabaseSync,
  envelopeRaw: string,
  filenameLabel: string,
  actorUserId: string,
  actorEmail: string,
  existingBackupId?: string
): {
  restored: boolean;
  backupId: string;
  filename: string;
  restoredAt: string;
  contractsCount: number;
  clientsCount: number;
  ledgerNetKopecks: number;
  reconciliation: ReconciliationResultDTO;
} {
  let envelope: {
    ciphertextBase64: string;
    ivHex: string;
    authTagHex: string;
    sha256Hash: string;
  };
  try {
    envelope = JSON.parse(envelopeRaw);
  } catch {
    throw new Error('Файл резервной копии повреждён или имеет неверный формат JSON.');
  }

  const decryptedJson = decryptBackupPayload(envelope);
  const parsed = JSON.parse(decryptedJson) as {
    createdAt: string;
    reconciliation: ReconciliationResultDTO;
    tables: {
      installment_plans?: Array<Record<string, unknown>>;
      clients?: Array<Record<string, unknown>>;
      suppliers?: Array<Record<string, unknown>>;
      purchases?: Array<Record<string, unknown>>;
      contracts?: Array<Record<string, unknown>>;
      schedule_versions?: Array<Record<string, unknown>>;
      schedule_items?: Array<Record<string, unknown>>;
      overdue_contacts?: Array<Record<string, unknown>>;
      financial_accounts?: Array<Record<string, unknown>>;
      payments?: Array<Record<string, unknown>>;
      payment_allocations?: Array<Record<string, unknown>>;
      ledger_entries?: Array<Record<string, unknown>>;
    };
  };

  if (!parsed.reconciliation || !parsed.reconciliation.isHealthy) {
    throw new Error('Невозможно выполнить восстановление: резервная копия содержит расхождение регистров.');
  }

  const tables = parsed.tables;
  const safeFilename = path.basename(filenameLabel || 'uploaded_backup.enc.json').replace(/[^a-zA-Z0-9._-]/g, '_');
  const backupId = existingBackupId || `bkp_${crypto.randomUUID().slice(0, 8)}`;

  // Ensure the envelope is also persisted in ./backups on disk
  if (!existingBackupId) {
    const backupDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(path.join(backupDir, safeFilename), envelopeRaw, { encoding: 'utf8', mode: 0o600 });
  }

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    // Clear operational tables in reverse FK dependency order
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

    const insertRow = (tableName: string, record: Record<string, unknown>) => {
      const keys = Object.keys(record);
      if (keys.length === 0) return;
      const cols = keys.join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${tableName} (${cols}) VALUES (${placeholders})`);
      stmt.run(...keys.map((k) => (record[k] === undefined ? null : (record[k] as string | number | null))));
    };

    for (const plan of tables.installment_plans || []) {
      insertRow('installment_plans', plan);
    }
    for (const acc of tables.financial_accounts || []) {
      insertRow('financial_accounts', acc);
    }
    for (const client of tables.clients || []) {
      insertRow('clients', client);
    }
    for (const supplier of tables.suppliers || []) {
      insertRow('suppliers', supplier);
    }
    for (const purchase of tables.purchases || []) {
      insertRow('purchases', purchase);
    }
    for (const contract of tables.contracts || []) {
      insertRow('contracts', contract);
    }
    for (const sv of tables.schedule_versions || []) {
      insertRow('schedule_versions', sv);
    }
    for (const si of tables.schedule_items || []) {
      insertRow('schedule_items', si);
    }
    for (const oc of tables.overdue_contacts || []) {
      insertRow('overdue_contacts', oc);
    }
    for (const pay of tables.payments || []) {
      insertRow('payments', pay);
    }
    for (const alloc of tables.payment_allocations || []) {
      insertRow('payment_allocations', alloc);
    }
    for (const le of tables.ledger_entries || []) {
      insertRow('ledger_entries', le);
    }

    const postRestoreReconciliation = reconcileFinance(db);
    if (!postRestoreReconciliation.isHealthy) {
      throw new Error(
        `Откат восстановления: после загрузки снимка обнаружены расхождения (${postRestoreReconciliation.discrepancies.join('; ')})`
      );
    }

    const restoredAt = new Date().toISOString();
    if (existingBackupId) {
      db.prepare(`UPDATE backups SET verified_restore_at = ?, status = 'verified' WHERE id = ?`).run(
        restoredAt,
        existingBackupId
      );
    } else {
      db.prepare(`
        INSERT OR REPLACE INTO backups (
          id, filename, size_bytes, sha256_hash, encrypted_alg,
          contracts_count, ledger_net_kopecks, verified_restore_at, status, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'AES-256-GCM', ?, ?, ?, 'verified', ?, ?)
      `).run(
        backupId,
        safeFilename,
        Buffer.byteLength(envelopeRaw, 'utf8'),
        envelope.sha256Hash,
        (tables.contracts || []).length,
        postRestoreReconciliation.totalCashAndBankKopecks,
        restoredAt,
        actorUserId,
        restoredAt
      );
    }

    recordAudit(db, {
      actorUserId,
      actorEmail,
      action: 'BACKUP_RESTORE_EXECUTED',
      entityType: 'backup',
      entityId: backupId,
      summary: `Выполнено полное восстановление базы данных из резервной копии ${safeFilename} (договоров: ${(tables.contracts || []).length}, клиентов: ${(tables.clients || []).length}).`,
    });

    db.exec('COMMIT;');

    return {
      restored: true,
      backupId,
      filename: safeFilename,
      restoredAt,
      contractsCount: (tables.contracts || []).length,
      clientsCount: (tables.clients || []).length,
      ledgerNetKopecks: postRestoreReconciliation.totalCashAndBankKopecks,
      reconciliation: postRestoreReconciliation,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}

export function restoreEncryptedBackup(
  db: DatabaseSync,
  backupId: string,
  actorUserId: string,
  actorEmail: string
) {
  const row = db.prepare('SELECT id, filename, sha256_hash FROM backups WHERE id = ?').get(backupId) as
    | { id: string; filename: string; sha256_hash: string }
    | undefined;

  if (!row) {
    throw new Error('Резервная копия не найдена.');
  }

  const safeFilename = path.basename(row.filename);
  const filePath = path.resolve(process.cwd(), 'backups', safeFilename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Файл резервной копии отсутствует на диске.');
  }

  const envelopeRaw = fs.readFileSync(filePath, 'utf8');
  return restoreEncryptedBackupFromEnvelope(
    db,
    envelopeRaw,
    safeFilename,
    actorUserId,
    actorEmail,
    backupId
  );
}


