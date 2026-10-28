/**
 * Safe Database Inspection, Encrypted Pre-Backup & Clean Reset CLI
 *
 * Usage:
 *   npm run db:inspect
 *     -> Inspects current database tables/records and creates + verifies a full AES-256-GCM backup WITHOUT deleting anything.
 *
 *   npm run db:clean -- --confirm-clean
 *     -> Creates + verifies an encrypted backup first, then removes demo/operational records inside a transaction
 *        while preserving schema, migrations, system installment_plans, financial_accounts (0 ₽), and the primary owner account.
 */

import { cleanResetOperationalData, getDb, inspectDatabaseRecords } from '../src/server/db/database';
import {
  createEncryptedBackup,
  reconcileFinance,
  verifyEncryptedBackup,
} from '../src/server/services/reconciliationAndBackup';

function main(): void {
  const args = process.argv.slice(2);
  const confirmClean = args.includes('--confirm-clean');
  const keepStaff = args.includes('--keep-staff');

  const db = getDb();
  const inventory = inspectDatabaseRecords(db);
  const reconBefore = reconcileFinance(db);

  console.log('====================================================================');
  console.log('[РассрочкаПро] ИНСПЕКЦИЯ БАЗЫ ДАННЫХ И РЕЗЕРВНОЕ КОПИРОВАНИЕ');
  console.log('====================================================================');
  console.log(`Время проверки: ${inventory.inspectedAt}`);
  console.log(
    `Целостность финансовых регистров: ${reconBefore.isHealthy ? 'OK (расхождений нет)' : 'ОШИБКА'}`
  );
  console.log('\nТекущее количество записей по таблицам:');
  for (const [table, count] of Object.entries(inventory.tableCounts)) {
    console.log(`  - ${table.padEnd(22, ' ')}: ${count}`);
  }

  console.log('\nУчётные записи пользователей:');
  for (const u of inventory.users) {
    console.log(`  - [${u.id}] ${u.phone} | роль: ${u.role} | статус: ${u.status} | ${u.full_name}`);
  }

  console.log('\nКлиенты в базе:');
  if (inventory.clients.length === 0) {
    console.log('  (нет записей)');
  } else {
    for (const c of inventory.clients) {
      console.log(`  - [${c.id}] ${c.full_name} (${c.phone})`);
    }
  }

  console.log('\nДоговоры в базе:');
  if (inventory.contracts.length === 0) {
    console.log('  (нет записей)');
  } else {
    for (const cnt of inventory.contracts) {
      console.log(`  - [${cnt.id}] ${cnt.contract_number} | ${cnt.item_title} | статус: ${cnt.status}`);
    }
  }

  // Always create and verify an encrypted backup before any potential cleanup
  const ownerRow = inventory.users.find((u) => u.role === 'owner') || {
    id: 'usr_owner_01',
    phone: '+79285550101',
  };

  const bkp = createEncryptedBackup(db, ownerRow.id, ownerRow.phone);
  const verified = verifyEncryptedBackup(db, bkp.id, ownerRow.id, ownerRow.phone);

  console.log('\nСоздана и проверена зашифрованная резервная копия (AES-256-GCM):');
  console.log(`  - ID копии       : ${bkp.id}`);
  console.log(`  - Файл на диске  : backups/${bkp.filename}`);
  console.log(`  - Размер         : ${bkp.sizeBytes} байт`);
  console.log(`  - SHA-256        : ${bkp.sha256Hash}`);
  console.log(`  - Верификация    : ${verified.verified ? 'УСПЕШНО ПРОВЕРЕНА' : 'ОШИБКА'}`);

  if (!confirmClean) {
    console.log('\n--------------------------------------------------------------------');
    console.log('БЕЗОПАСНЫЙ РЕЖИМ ИНСПЕКЦИИ: данные НЕ были удалены.');
    console.log('При запуске очистки с флагом --confirm-clean:');
    console.log('  БУДУТ ОЧИЩЕНЫ операционные/демо-таблицы:');
    console.log(
      '    clients, suppliers, purchases, contracts, schedule_versions, schedule_items,'
    );
    console.log(
      '    overdue_contacts, payments, payment_allocations, ledger_entries, documents'
    );
    console.log('  БУДУТ СОХРАНЕНЫ:');
    console.log('    - схема БД, индексы и миграции');
    console.log('    - системные тарифы рассрочки (installment_plans)');
    console.log('    - счета кассы и банка (financial_accounts со сбросом баланса в 0,00 ₽)');
    console.log('    - активный администратор (owner: +79285550101)');
    console.log('    - журнал резервных копий (backups) и аудит (audit_logs)');
    console.log('\nДля подтверждённой очистки выполните:');
    console.log('  npm run db:clean -- --confirm-clean');
    console.log('====================================================================');
    return;
  }

  console.log('\nВыполняется подтверждённая очистка операционных и демонстрационных данных...');
  const cleanResult = cleanResetOperationalData(db, ownerRow.id, ownerRow.phone, {
    keepStaffUsers: keepStaff,
  });
  const reconAfter = reconcileFinance(db);

  console.log('Очистка завершена успешно:');
  console.log(`  - Удалено записей по таблицам : ${JSON.stringify(cleanResult.deletedCounts)}`);
  console.log(`  - Сохранено администраторов   : ${cleanResult.preservedUsers}`);
  console.log(`  - Сохранено тарифов рассрочки : ${cleanResult.preservedPlans}`);
  console.log(`  - Сброшено счетов в 0,00 ₽    : ${cleanResult.resetAccountsCount}`);
  console.log(`  - Сверка регистров после сброса: ${reconAfter.isHealthy ? 'OK (0,00 ₽)' : 'ОШИБКА'}`);
  console.log('====================================================================');
}

main();
