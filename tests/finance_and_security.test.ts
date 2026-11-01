import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  calculateContractAndSchedule,
  calculateDaysOverdue,
  calculateEarlyPayoffComparison,
  calculateTotalCostKopecks,
  computeAutomaticScheduleAllocations,
  recalculateUnpaidScheduleDates,
  sanitizeSpreadsheetCell,
} from '../src/server/finance/calculator';
import {
  applyTariffProfileToContractTerms,
  createInitialContractClientState,
  createInitialContractTermsState,
  formatWelcomeGreeting,
  getSafeInitialLaunchSection,
  shouldLoadConfidentialState,
  switchContractFormToExistingClient,
  switchContractFormToNewClient,
  validateContractTermsState,
} from '../src/shared/contractFormHelpers';
import {
  computeTotpCode,
  decryptBackupPayload,
  encryptBackupPayload,
  generateTotpSecret,
  hashPassword,
  normalizeRussianPhone,
  validateUploadedFileSignature,
  verifyPassword,
  verifyTotpCode,
} from '../src/server/security/crypto';
import { getDb, withTransaction } from '../src/server/db/database';
import { reconcileFinance } from '../src/server/services/reconciliationAndBackup';
import { createAppServer } from '../server';

test('Unit: Расчёт полной себестоимости, наценки 25% (6 мес.) и 33% (12 мес.) и точности графика до копейки', () => {
  const totalCost = calculateTotalCostKopecks(8000000, 120000, 0);
  assert.equal(totalCost, 8120000);

  const calc6 = calculateContractAndSchedule({
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

  assert.equal(calc6.salePriceKopecks, 10150000);
  assert.equal(calc6.downPaymentKopecks, 3045000);
  assert.equal(calc6.financedPrincipalKopecks, 7105000);

  const sumSchedule6 = calc6.schedule.reduce((acc, item) => acc + item.plannedKopecks, 0);
  assert.equal(sumSchedule6, calc6.financedPrincipalKopecks);
  assert.equal(calc6.schedule[0].plannedKopecks, 1184166);
  assert.equal(calc6.schedule[5].plannedKopecks, 1184170);

  const calc12 = calculateContractAndSchedule({
    purchaseCostKopecks: 5800000,
    deliveryCostKopecks: 200000,
    otherCostKopecks: 0,
    markupPercent: 33,
    downPaymentPercent: 30,
    termMonths: 12,
    roundingRule: 'ruble',
    scheduleType: 'equal',
    startDate: '2026-09-25',
  });

  assert.equal(calc12.totalCostKopecks, 6000000);
  assert.equal(calc12.salePriceKopecks, 7980000);
  assert.equal(calc12.downPaymentKopecks, 2394000);
  assert.equal(calc12.financedPrincipalKopecks, 5586000);
  const sumSchedule12 = calc12.schedule.reduce((acc, item) => acc + item.plannedKopecks, 0);
  assert.equal(sumSchedule12, 5586000);
});

test('Unit: Калькулятор сравнения 4 вариантов досрочного погашения и расчёт просрочки без штрафов', () => {
  const options = calculateEarlyPayoffComparison({
    totalCostKopecks: 6000000,
    salePriceKopecks: 7980000,
    downPaymentKopecks: 2394000,
    termMonths: 12,
    remainingScheduleKopecks: 5586000,
    unpaidInstallmentsCount: 10,
    planDiscountPercent: 35,
    manualPayoffKopecks: 5000000,
  });

  assert.equal(options.length, 4);
  assert.equal(options[0].mode, 'full_balance');
  assert.equal(options[0].payoffAmountKopecks, 5586000);
  assert.equal(options[0].discountKopecks, 0);

  const manualOpt = options.find((o) => o.mode === 'manual_owner')!;
  assert.equal(manualOpt.payoffAmountKopecks, 5000000);
  assert.equal(manualOpt.discountKopecks, 586000);

  assert.equal(calculateDaysOverdue('2026-10-15', '2026-10-28'), 13);
  assert.equal(calculateDaysOverdue('2026-10-28', '2026-10-28'), 0);

  // Проверка распределения по умолчанию ('spread_remaining'):
  // Платеж по 15 000 ₽/мес (4 месяца), клиент вносит 18 000 ₽ -> 1-й месяц закрывается (15 000 ₽),
  // оставшиеся 3 000 ₽ распределяются поровну по 1 000 ₽ на 2-й, 3-й и 4-й месяцы.
  const fourMonths15k = [
    { id: 'm1', remainingKopecks: 1500000 },
    { id: 'm2', remainingKopecks: 1500000 },
    { id: 'm3', remainingKopecks: 1500000 },
    { id: 'm4', remainingKopecks: 1500000 },
  ];
  const spreadAllocs = computeAutomaticScheduleAllocations(1800000, fourMonths15k);
  assert.equal(spreadAllocs.length, 4);
  assert.deepEqual(spreadAllocs, [
    { scheduleItemId: 'm1', amountKopecks: 1500000 },
    { scheduleItemId: 'm2', amountKopecks: 100000 },
    { scheduleItemId: 'm3', amountKopecks: 100000 },
    { scheduleItemId: 'm4', amountKopecks: 100000 },
  ]);

  // Проверка последовательного режима ('sequential'):
  // 15 000 ₽ закрывают 1-й месяц, а 3 000 ₽ целиком идут во 2-й месяц.
  const seqAllocs = computeAutomaticScheduleAllocations(1800000, fourMonths15k, 'sequential');
  assert.deepEqual(seqAllocs, [
    { scheduleItemId: 'm1', amountKopecks: 1500000 },
    { scheduleItemId: 'm2', amountKopecks: 300000 },
  ]);
});

test('Security: Нормализация российских номеров, CSV Formula Injection, KDF хеширование, TOTP MFA, Magic Bytes и AES-256-GCM', () => {
  // Phone normalization
  assert.equal(normalizeRussianPhone('+7 (928) 555-01-01'), '+79285550101');
  assert.equal(normalizeRussianPhone('8 928 555 01 01'), '+79285550101');
  assert.equal(normalizeRussianPhone('7-928-555-01-01'), '+79285550101');
  assert.equal(normalizeRussianPhone('9285550101'), '+79285550101');
  assert.equal(normalizeRussianPhone('+89285550101'), null);
  assert.equal(normalizeRussianPhone('12345'), null);
  assert.equal(normalizeRussianPhone('+79285550101abc'), null);

  // CSV Formula Injection
  assert.equal(sanitizeSpreadsheetCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(sanitizeSpreadsheetCell('+SUM(A1:A10)'), "'+SUM(A1:A10)");
  assert.equal(sanitizeSpreadsheetCell('@import'), "'@import");
  assert.equal(sanitizeSpreadsheetCell('Гаджиев Марат'), 'Гаджиев Марат');

  // Password hashing
  const hash = hashPassword('StrongSecret!2026');
  assert.equal(verifyPassword('StrongSecret!2026', hash), true);
  assert.equal(verifyPassword('WrongPassword!2026', hash), false);

  // TOTP MFA
  const secret = generateTotpSecret();
  const code = computeTotpCode(secret);
  assert.equal(verifyTotpCode(secret, code), true);
  assert.equal(verifyTotpCode(secret, '000000'), code === '000000');

  // File signature (Magic Bytes)
  const validPdf = Buffer.from('%PDF-1.4 sample content', 'utf8');
  assert.equal(validateUploadedFileSignature(validPdf, 'application/pdf', 'contract.pdf').valid, true);

  const fakePdfWithScript = Buffer.from('<script>alert(1)</script>', 'utf8');
  assert.equal(
    validateUploadedFileSignature(fakePdfWithScript, 'application/pdf', 'evil.pdf').valid,
    false
  );

  // AES-256-GCM Backup Encryption & Integrity verification
  const payload = JSON.stringify({ contracts: 2, totalKopecks: 42310000 });
  const encrypted = encryptBackupPayload(payload);
  const decrypted = decryptBackupPayload(encrypted);
  assert.equal(decrypted, payload);

  assert.throws(() => {
    decryptBackupPayload({
      ...encrypted,
      sha256Hash: '0000000000000000000000000000000000000000000000000000000000000000',
    });
  });
});

test('Integration: Изоляция настроек рассрочки от старых договоров и автоматическая сверка регистров БД', () => {
  const db = getDb(':memory:');

  const initialRecon = reconcileFinance(db);
  assert.equal(initialRecon.isHealthy, true);
  assert.equal(initialRecon.discrepancies.length, 0);

  withTransaction(db, () => {
    db.prepare('UPDATE installment_plans SET markup_percent = 40, version = version + 1 WHERE id = ?').run(
      'plan_6m_std'
    );
  });

  const existingContract = db
    .prepare('SELECT markup_percent, sale_price_kopecks FROM contracts WHERE id = ?')
    .get('cnt_01') as { markup_percent: number; sale_price_kopecks: number };

  assert.equal(existingContract.markup_percent, 25);
  assert.equal(existingContract.sale_price_kopecks, 10150000);
});

test('Mandatory Security Suite (1–14): Полная проверка защиты входа по телефону, brute-force лимитов, RBAC, IDOR, отзыва сессий и отсутствия утечек секретов', async () => {
  const { app, db } = await createAppServer(':memory:');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiCall(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      sessionToken?: string;
      csrfToken?: string;
      clientIp?: string;
      nowMs?: number;
    } = {}
  ) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.sessionToken) headers['X-Session-Token'] = options.sessionToken;
    if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken;
    if (options.clientIp) headers['X-Test-Client-Ip'] = options.clientIp;
    if (options.nowMs !== undefined) headers['X-Test-Now-Ms'] = String(options.nowMs);

    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  try {
    const baseTimeMs = Date.now() - 20 * 60 * 1000;

    // 7 & 8. Несуществующий номер, неверный пароль и заблокированный аккаунт возвращают одинаковое сообщение 401
    const resUnknownPhone = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.10.0.1',
      nowMs: baseTimeMs,
      body: { phone: '+7 (999) 000-11-22', password: 'SomePassword!123' },
    });
    assert.equal(resUnknownPhone.status, 401);
    assert.equal(resUnknownPhone.data.error, 'Неверный номер телефона или пароль');

    const resWrongPass = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.10.0.2',
      nowMs: baseTimeMs,
      body: { phone: '+7 (928) 555-01-01', password: 'WrongPassword!123' },
    });
    assert.equal(resWrongPass.status, 401);
    assert.equal(resWrongPass.data.error, 'Неверный номер телефона или пароль');

    const resBlockedUser = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.10.0.3',
      nowMs: baseTimeMs,
      body: { phone: '+7 (928) 555-01-09', password: 'BlockedPass!2026' },
    });
    assert.equal(resBlockedUser.status, 401);
    assert.equal(resBlockedUser.data.error, 'Неверный номер телефона или пароль');

    // Reset rate limits before testing exact 5-attempt window
    db.prepare('DELETE FROM auth_rate_limits').run();
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL').run();

    // 1, 4 & 5. Смена IP и смена формата номера не позволяют обойти лимит 5 попыток за 15 минут; 6-я попытка блокируется (429)
    const phoneFormats = [
      '+7 (928) 555-01-02',
      '8 928 555-01-02',
      '79285550102',
      '9285550102',
      '+7-928-555-01-02',
    ];
    for (let i = 0; i < 5; i++) {
      const attempt = await apiCall('/api/v1/auth/login', {
        method: 'POST',
        clientIp: `10.20.0.${i + 1}`, // Different IP on every attempt!
        nowMs: baseTimeMs + i * 1000,
        body: { phone: phoneFormats[i], password: 'WrongStaffPassword!' },
      });
      assert.equal(attempt.status, 401);
    }

    // 6th attempt within the 15-minute window is blocked with 429 (even from a brand new IP and with the right password!)
    const sixthAttempt = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.20.0.99',
      nowMs: baseTimeMs + 10_000,
      body: { phone: '+79285550102', password: 'StaffPass!2026' },
    });
    assert.equal(sixthAttempt.status, 429);

    // 2. После истечения 15 минут блокировки пользователь может снова войти
    const afterLockoutExpired = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.20.0.100',
      nowMs: baseTimeMs + 16 * 60 * 1000, // +16 minutes
      body: { phone: '8 (928) 555-01-02', password: 'StaffPass!2026' },
    });
    assert.equal(afterLockoutExpired.status, 200);
    assert.equal(afterLockoutExpired.data.authenticated, true);
    const staffSessionToken = afterLockoutExpired.data.sessionToken;
    const staffCsrfToken = afterLockoutExpired.data.csrfToken;

    // 3. Параллельные запросы не обходят лимит (атомарная транзакция)
    db.prepare('DELETE FROM auth_rate_limits').run();
    const parallelResults = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        apiCall('/api/v1/auth/login', {
          method: 'POST',
          clientIp: `10.30.0.${idx + 1}`,
          nowMs: baseTimeMs,
          body: { phone: '+79285550109', password: 'WrongParallelPassword!' },
        })
      )
    );
    const count401 = parallelResults.filter((r) => r.status === 401).length;
    const count429 = parallelResults.filter((r) => r.status === 429).length;
    assert.equal(count401, 5);
    assert.equal(count429, 3);

    // 6. Атака с одного IP на множество разных аккаунтов ограничивается (credential stuffing protection)
    db.prepare('DELETE FROM auth_rate_limits').run();
    for (let i = 0; i < 15; i++) {
      const num = `+792877700${String(i).padStart(2, '0')}`;
      const res = await apiCall('/api/v1/auth/login', {
        method: 'POST',
        clientIp: '192.0.2.77',
        nowMs: baseTimeMs,
        body: { phone: num, password: 'SprayPassword!123' },
      });
      assert.equal(res.status, 401);
    }
    const sixteenthFromSameIp = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '192.0.2.77',
      nowMs: baseTimeMs + 1000,
      body: { phone: '+79287770099', password: 'SprayPassword!123' },
    });
    assert.equal(sixteenthFromSameIp.status, 429);

    // 9 & 10. Обычный пользователь (staff) не может создать пользователя, повысить себе роль или получить чужой профиль (IDOR/BOLA)
    const staffCreateUserAttempt = await apiCall('/api/v1/users', {
      method: 'POST',
      sessionToken: staffSessionToken,
      csrfToken: staffCsrfToken,
      body: { phone: '+79281112233', password: 'InitialPassword!1', role: 'owner' },
    });
    assert.equal(staffCreateUserAttempt.status, 403);

    const staffEscalateRoleAttempt = await apiCall('/api/v1/users/usr_staff_01/role', {
      method: 'POST',
      sessionToken: staffSessionToken,
      csrfToken: staffCsrfToken,
      body: { role: 'owner' },
    });
    assert.equal(staffEscalateRoleAttempt.status, 403);

    const staffIdorAttempt = await apiCall('/api/v1/users/usr_owner_01', {
      method: 'GET',
      sessionToken: staffSessionToken,
    });
    assert.equal(staffIdorAttempt.status, 403);

    // Вход администратора (owner) и создание нового пользователя
    const adminLogin = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.50.0.1',
      nowMs: baseTimeMs,
      body: { phone: '+7 (928) 555-01-01', password: 'MoOwner!2026' },
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.data.sessionToken;
    const adminCsrf = adminLogin.data.csrfToken;

    const createNewStaff = await apiCall('/api/v1/users', {
      method: 'POST',
      sessionToken: adminToken,
      csrfToken: adminCsrf,
      body: {
        phone: '8 (928) 444-55-66',
        password: 'TempInitialPass!2026',
        fullName: 'Кассир Марат',
        role: 'staff',
        mustChangePassword: true,
      },
    });
    assert.equal(createNewStaff.status, 201);
    assert.equal(createNewStaff.data.phone, '+79284445566');
    assert.equal(createNewStaff.data.mustChangePassword, true);
    const newStaffId = createNewStaff.data.id;

    // Попытка создать дубликат того же номера в другом формате -> 409 Conflict
    const dupPhoneAttempt = await apiCall('/api/v1/users', {
      method: 'POST',
      sessionToken: adminToken,
      csrfToken: adminCsrf,
      body: {
        phone: '+7-928-444-55-66',
        password: 'AnotherPassword!2026',
        role: 'staff',
      },
    });
    assert.equal(dupPhoneAttempt.status, 409);

    // 12. После сброса пароля администратором старые сессии пользователя немедленно отзываются
    const newStaffLogin = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      clientIp: '10.60.0.1',
      nowMs: baseTimeMs,
      body: { phone: '+79284445566', password: 'TempInitialPass!2026' },
    });
    assert.equal(newStaffLogin.status, 200);
    const oldStaffSession = newStaffLogin.data.sessionToken;

    const resetRes = await apiCall(`/api/v1/users/${newStaffId}/reset-password`, {
      method: 'POST',
      sessionToken: adminToken,
      csrfToken: adminCsrf,
      body: { newPassword: 'ResetByAdminPass!2026', mustChangePassword: true },
    });
    assert.equal(resetRes.status, 200);

    // Старая сессия должна быть недействительна (401)
    const stateWithOldSession = await apiCall('/api/v1/state', {
      method: 'GET',
      sessionToken: oldStaffSession,
    });
    assert.equal(stateWithOldSession.status, 401);

    // 11. После выхода (logout) защищённые API больше не доступны по старой сессии
    const logoutRes = await apiCall('/api/v1/auth/logout', {
      method: 'POST',
      sessionToken: staffSessionToken,
      csrfToken: staffCsrfToken,
    });
    assert.equal(logoutRes.status, 200);

    const afterLogoutCheck = await apiCall('/api/v1/state', {
      method: 'GET',
      sessionToken: staffSessionToken,
    });
    assert.equal(afterLogoutCheck.status, 401);

    // 13. Старые маршруты регистрации отключены (404), а секреты/пароли не попадают в логи и ответы API
    const regReq = await apiCall('/api/v1/auth/register-request', {
      method: 'POST',
      body: { phone: '+79280000000', password: 'SecretPassword123!' },
    });
    assert.equal(regReq.status, 404);

    // 14. Проверка работы основного функционала и отсутствия секретов в выдаче /state
    const adminState = await apiCall('/api/v1/state', {
      method: 'GET',
      sessionToken: adminToken,
    });
    assert.equal(adminState.status, 200);
    assert.equal(adminState.data.reconciliation.isHealthy, true);
    assert.ok(adminState.data.contracts.length >= 2);

    const serializedState = JSON.stringify(adminState.data);
    assert.equal(serializedState.includes('password_hash'), false);
    assert.equal(serializedState.includes('MoOwner!2026'), false);
    assert.equal(serializedState.includes('ResetByAdminPass!2026'), false);
    assert.equal(serializedState.includes(adminToken), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('6. Сквозной production-тест: Healthcheck, CSRF, клиенты, договоры, платежи, приватные файлы, Backup & Restore и Clean Reset', async () => {
  const { app, db } = await createAppServer(':memory:');
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function apiCall(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      sessionToken?: string;
      csrfToken?: string;
    } = {}
  ) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.sessionToken) {
      headers['X-Session-Token'] = options.sessionToken;
    }
    if (options.csrfToken) {
      headers['X-CSRF-Token'] = options.csrfToken;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await res.json()
      : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }

  try {
    // 1. Healthcheck endpoint
    const health = await apiCall('/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ok');
    assert.equal(health.data.dbConnected, true);
    assert.equal(health.data.reconciliationHealthy, true);

    // Login as owner and staff
    const ownerLogin = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      body: { phone: '+79285550101', password: 'MoOwner!2026' },
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = ownerLogin.data.sessionToken;
    const ownerCsrf = ownerLogin.data.csrfToken;

    const staffLogin = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      body: { phone: '+79285550102', password: 'StaffPass!2026' },
    });
    assert.equal(staffLogin.status, 200);
    const staffToken = staffLogin.data.sessionToken;
    const staffCsrf = staffLogin.data.csrfToken;

    // 2. Strict CSRF enforcement: mutating request without CSRF token or with wrong CSRF token -> 403
    const missingCsrfRes = await apiCall('/api/v1/clients', {
      method: 'POST',
      sessionToken: ownerToken,
      body: { fullName: 'Тест Без CSRF', phone: '+79283334455' },
    });
    assert.equal(missingCsrfRes.status, 403);

    const wrongCsrfRes = await apiCall('/api/v1/clients', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: 'invalid_csrf_token_value',
      body: { fullName: 'Тест Неверный CSRF', phone: '+79283334455' },
    });
    assert.equal(wrongCsrfRes.status, 403);

    // 3. Client creation, normalization, duplicate check, editing & SQLi safety
    const createClientRes = await apiCall('/api/v1/clients', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        fullName: "Абдуллаев Рустам '; DROP TABLE clients; --",
        phone: '8 (928) 333-44-55',
        address: 'г. Махачкала, пр. Шамиля, 10',
      },
    });
    assert.equal(createClientRes.status, 201);
    assert.equal(createClientRes.data.phone, '+79283334455');
    const createdClientId = createClientRes.data.id;

    // Duplicate phone in different format -> 409 Conflict
    const dupClientRes = await apiCall('/api/v1/clients', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        fullName: 'Дубликат Клиента',
        phone: '+7-928-333-44-55',
      },
    });
    assert.equal(dupClientRes.status, 409);

    // Edit client via PATCH /api/v1/clients/:id
    const editClientRes = await apiCall(`/api/v1/clients/${createdClientId}`, {
      method: 'PATCH',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
      body: {
        fullName: 'Абдуллаев Рустам Камильевич',
        address: 'г. Махачкала, пр. Шамиля, 12',
      },
    });
    assert.equal(editClientRes.status, 200);
    assert.equal(editClientRes.data.fullName, 'Абдуллаев Рустам Камильевич');

    // 4. Contract creation, payment idempotency, manual allocation & overpayment protection
    // First verify that contract without confirmedCalculation is rejected (400)
    const unconfirmedContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientId: createdClientId,
        planId: 'plan_6m_std',
        itemTitle: 'Ноутбук Apple MacBook Air 15 M3',
        purchaseCostKopecks: 10000000,
        confirmedCalculation: false,
      },
    });
    assert.equal(unconfirmedContractRes.status, 400);

    const createContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientId: createdClientId,
        planId: 'plan_6m_std',
        itemTitle: 'Ноутбук Apple MacBook Air 15 M3',
        purchaseCostKopecks: 10000000, // 100 000 ₽
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25, // 125 000 ₽ sale price
        downPaymentPercent: 30, // 37 500 ₽ down payment, 87 500 ₽ financed
        termMonths: 6,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-01',
        downPaymentAccountId: 'acc_cash_main',
        downPaymentMethod: 'cash',
        collectDownPaymentNow: true,
        confirmedCalculation: true,
      },
    });
    assert.equal(createContractRes.status, 201);
    const newContractId = createContractRes.data.id;

    // Record unallocated payment with idempotency key
    const idemKey = 'idem_test_payment_unique_001';
    const payRes1 = await apiCall('/api/v1/payments', {
      method: 'POST',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
      body: {
        idempotencyKey: idemKey,
        clientId: createdClientId,
        contractId: newContractId,
        accountId: 'acc_bank_main',
        paymentMethod: 'bank_transfer',
        amountKopecks: 1000000, // 10 000 ₽
        eventDate: '2026-10-28',
        notes: 'Частичный платёж по СБП',
        allocations: [],
      },
    });
    assert.equal(payRes1.status, 201);
    const paymentId = payRes1.data.id;

    // Replay same idempotencyKey -> must NOT double-credit balance
    const payResReplay = await apiCall('/api/v1/payments', {
      method: 'POST',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
      body: {
        idempotencyKey: idemKey,
        clientId: createdClientId,
        contractId: newContractId,
        accountId: 'acc_bank_main',
        paymentMethod: 'bank_transfer',
        amountKopecks: 1000000,
        eventDate: '2026-10-28',
        allocations: [],
      },
    });
    // Either 200 idempotent return or 400 duplicate key rejection; never double-applied
    assert.ok([200, 400, 409].includes(payResReplay.status));

    // Fetch contract schedule items
    const stateBeforeAlloc = await apiCall('/api/v1/state', {
      sessionToken: ownerToken,
    });
    const createdContract = stateBeforeAlloc.data.contracts.find(
      (c: { id: string }) => c.id === newContractId
    );
    assert.ok(createdContract);
    const firstInstallment = createdContract.schedule[0];

    // Overpayment attempt on single schedule item beyond payment unallocated amount -> 400
    const overAllocRes = await apiCall(`/api/v1/payments/${paymentId}/allocate`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        contractId: newContractId,
        allocations: [{ scheduleItemId: firstInstallment.id, amountKopecks: 5000000 }], // 50 000 ₽ > 10 000 ₽ available
      },
    });
    assert.equal(overAllocRes.status, 400);

    // Valid partial manual allocation (10 000 ₽ onto 1st installment)
    const validAllocRes = await apiCall(`/api/v1/payments/${paymentId}/allocate`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        contractId: newContractId,
        allocations: [{ scheduleItemId: firstInstallment.id, amountKopecks: 1000000 }],
      },
    });
    assert.equal(validAllocRes.status, 200);

    // 4b. Автоматическое каскадное распределение платежа (15 000 ₽ при графике по 7 000 ₽ в месяц)
    // Регистрируем платеж 15 000 ₽ с флагом autoAllocate: true
    const autoPayRes = await apiCall('/api/v1/payments', {
      method: 'POST',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
      body: {
        idempotencyKey: 'idem_auto_alloc_test_15000',
        clientId: createdClientId,
        contractId: newContractId,
        accountId: 'acc_bank_main',
        paymentMethod: 'bank_transfer',
        amountKopecks: 1500000, // 15 000 ₽
        eventDate: '2026-10-29',
        notes: 'Автораспределение 15 000 ₽ по графику',
        autoAllocate: true,
      },
    });
    assert.equal(autoPayRes.status, 201);

    // Проверяем состояние графика договора: платеж распределился по цепочке
    const stateAfterAutoPay = await apiCall('/api/v1/state', {
      sessionToken: ownerToken,
    });
    const contractAfterAuto = stateAfterAutoPay.data.contracts.find(
      (c: { id: string }) => c.id === newContractId
    );
    assert.ok(contractAfterAuto);
    // Первый платеж получил 10 000 ₽ ранее + остаток до полного закрытия (14 583,34 ₽)
    assert.equal(contractAfterAuto.schedule[0].status, 'paid');
    // Второй платеж получил оставшуюся часть суммы от 15 000 ₽
    assert.ok(contractAfterAuto.schedule[1].paidKopecks > 0);
    // Общая внесенная сумма по графику договора увеличилась ровно на 10 000 ₽ + 15 000 ₽
    assert.equal(contractAfterAuto.totalPaidOnScheduleKopecks, 1000000 + 1500000);

    // 5. Private Document Upload, Authenticated Download & Owner Delete
    const validPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'utf8');
    const uploadRes = await apiCall('/api/v1/documents/upload', {
      method: 'POST',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
      body: {
        entityType: 'contract',
        entityId: newContractId,
        docCategory: 'contract_scan',
        title: 'Скан подписанного договора MacBook Air',
        originalFilename: 'contract_macbook.pdf',
        mimeType: 'application/pdf',
        contentBase64: validPdfBytes.toString('base64'),
      },
    });
    assert.equal(uploadRes.status, 201);
    const uploadedDocId = uploadRes.data.id;

    // Unauthenticated download must be blocked with 401
    const unauthDownload = await apiCall(`/api/v1/documents/${uploadedDocId}/download`);
    assert.equal(unauthDownload.status, 401);

    // Authenticated download returns exact bytes and nosniff header
    const authDownload = await apiCall(`/api/v1/documents/${uploadedDocId}/download`, {
      sessionToken: staffToken,
    });
    assert.equal(authDownload.status, 200);
    assert.equal(authDownload.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(authDownload.data as ArrayBuffer).toString('utf8'), validPdfBytes.toString('utf8'));

    // Staff cannot delete document (403)
    const staffDelDoc = await apiCall(`/api/v1/documents/${uploadedDocId}`, {
      method: 'DELETE',
      sessionToken: staffToken,
      csrfToken: staffCsrf,
    });
    assert.equal(staffDelDoc.status, 403);

    // Owner can delete document (200)
    const ownerDelDoc = await apiCall(`/api/v1/documents/${uploadedDocId}`, {
      method: 'DELETE',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(ownerDelDoc.status, 200);

    // 6. Full Encrypted Backup -> Clean Reset -> Full Restore Verification
    const createBkpRes = await apiCall('/api/v1/security/backups', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(createBkpRes.status, 201);
    const backupId = createBkpRes.data.id;
    assert.equal(createBkpRes.data.contractsCount, 3); // 2 initial + 1 MacBook Air

    // Verify backup
    const verifyBkpRes = await apiCall(`/api/v1/security/backups/${backupId}/verify`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(verifyBkpRes.status, 200);
    assert.equal(verifyBkpRes.data.verified, true);

    // Execute cleanResetOperationalData on the test DB to simulate a wiped/clean state
    const { cleanResetOperationalData } = await import('../src/server/db/database');
    const cleanStats = cleanResetOperationalData(db, 'usr_owner_01', '+79285550101');
    assert.equal(cleanStats.deletedCounts.contracts, 3);
    assert.equal(cleanStats.preservedPlans, 3);

    const stateAfterClean = await apiCall('/api/v1/state', { sessionToken: ownerToken });
    assert.equal(stateAfterClean.data.contracts.length, 0);
    assert.equal(stateAfterClean.data.clients.length, 0);
    assert.equal(stateAfterClean.data.reconciliation.isHealthy, true);
    assert.equal(stateAfterClean.data.reconciliation.totalCashAndBankKopecks, 0);

    // Now restore from the encrypted backup via POST /api/v1/security/backups/:id/restore
    const restoreRes = await apiCall(`/api/v1/security/backups/${backupId}/restore`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.data.restored, true);
    assert.equal(restoreRes.data.contractsCount, 3);
    assert.equal(restoreRes.data.clientsCount, 3);
    assert.equal(restoreRes.data.reconciliation.isHealthy, true);

    // Confirm restored state matches pre-clean state
    const stateAfterRestore = await apiCall('/api/v1/state', { sessionToken: ownerToken });
    assert.equal(stateAfterRestore.data.contracts.length, 3);
    assert.equal(stateAfterRestore.data.clients.length, 3);
    assert.equal(stateAfterRestore.data.reconciliation.isHealthy, true);

    // 7. Custom Actual Down Payment: All 11 Required Scenarios
    // Scenario 1 & 2: Default OFF -> works identically to standard behavior
    const calcDefaultOff = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000, // 80 000 ₽
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25, // Sale price = 100 000 ₽ (10 000 000 kop)
      downPaymentPercent: 30, // Planned DP = 30 000 ₽ (3 000 000 kop)
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcDefaultOff.useCustomActualDownPayment, false);
    assert.equal(calcDefaultOff.salePriceKopecks, 10000000);
    assert.equal(calcDefaultOff.plannedDownPaymentKopecks, 3000000);
    assert.equal(calcDefaultOff.actualDownPaymentKopecks, 3000000);
    assert.equal(calcDefaultOff.downPaymentDiffKopecks, 0);
    assert.equal(calcDefaultOff.financedPrincipalKopecks, 7000000);
    assert.equal(calcDefaultOff.scheduleChanged, false);

    // Scenario 3: Toggle ON, Actual == Planned (30 000 ₽ == 30 000 ₽)
    const calcEqualActual = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25,
      downPaymentPercent: 30,
      useCustomActualDownPayment: true,
      actualDownPaymentKopecks: 3000000,
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcEqualActual.useCustomActualDownPayment, true);
    assert.equal(calcEqualActual.downPaymentDiffKopecks, 0);
    assert.equal(calcEqualActual.extraDownPaymentKopecks, 0);
    assert.equal(calcEqualActual.downPaymentShortfallKopecks, 0);
    assert.equal(calcEqualActual.scheduleChanged, false);
    assert.equal(calcEqualActual.financedPrincipalKopecks, 7000000);

    // Scenario 4: Actual < Planned (Shortfall: Planned 30 000 ₽, Actual 20 000 ₽ -> Shortfall 10 000 ₽ added to schedule)
    const calcShortfall = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25, // Sale price = 100 000 ₽
      downPaymentPercent: 30, // Planned = 30 000 ₽
      useCustomActualDownPayment: true,
      actualDownPaymentKopecks: 2000000, // Actual = 20 000 ₽
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcShortfall.plannedDownPaymentKopecks, 3000000);
    assert.equal(calcShortfall.actualDownPaymentKopecks, 2000000);
    assert.equal(calcShortfall.downPaymentShortfallKopecks, 1000000);
    assert.equal(calcShortfall.extraDownPaymentKopecks, 0);
    assert.equal(calcShortfall.downPaymentDiffKopecks, -1000000);
    assert.equal(calcShortfall.financedPrincipalKopecks, 8000000); // 80 000 ₽ instead of 70 000 ₽
    assert.equal(calcShortfall.scheduleChanged, true);
    assert.equal(
      calcShortfall.schedule.reduce((s, i) => s + i.plannedKopecks, 0),
      8000000
    );
    // Each month increased from 14 000 ₽ to 16 000 ₽ (+2 000 ₽)
    assert.equal(calcShortfall.schedule[0].originalPlannedKopecks, 1400000);
    assert.equal(calcShortfall.schedule[0].plannedKopecks, 1600000);
    assert.equal(calcShortfall.schedule[0].diffKopecks, 200000);

    // Scenario 5: Actual == 0 ₽ (Full 100 000 ₽ goes into schedule)
    const calcZeroActual = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25,
      downPaymentPercent: 30,
      useCustomActualDownPayment: true,
      actualDownPaymentKopecks: 0,
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcZeroActual.actualDownPaymentKopecks, 0);
    assert.equal(calcZeroActual.downPaymentShortfallKopecks, 3000000);
    assert.equal(calcZeroActual.financedPrincipalKopecks, 10000000);
    assert.equal(
      calcZeroActual.schedule.reduce((s, i) => s + i.plannedKopecks, 0),
      10000000
    );

    // Scenario 6, 7, 8: Actual > Planned (Spec example: Sale 100 000 ₽, Planned 30 000 ₽, Actual 35 000 ₽ -> Remaining 65 000 ₽)
    const calcOverpay = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25, // Sale price = 100 000 ₽
      downPaymentPercent: 30, // Planned = 30 000 ₽
      useCustomActualDownPayment: true,
      actualDownPaymentKopecks: 3500000, // Actual = 35 000 ₽
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcOverpay.salePriceKopecks, 10000000);
    assert.equal(calcOverpay.plannedDownPaymentKopecks, 3000000);
    assert.equal(calcOverpay.actualDownPaymentKopecks, 3500000);
    assert.equal(calcOverpay.extraDownPaymentKopecks, 500000); // 5 000 ₽ extra repayment
    assert.equal(calcOverpay.downPaymentShortfallKopecks, 0);
    assert.equal(calcOverpay.financedPrincipalKopecks, 6500000); // 65 000 ₽ remaining
    assert.equal(
      calcOverpay.schedule.reduce((s, i) => s + i.plannedKopecks, 0),
      6500000
    );
    // Each month decreased from 14 000 ₽ to 13 000 ₽ (-1 000 ₽)
    assert.equal(calcOverpay.schedule[0].originalPlannedKopecks, 1400000);
    assert.equal(calcOverpay.schedule[0].plannedKopecks, 1300000);
    assert.equal(calcOverpay.schedule[0].diffKopecks, -100000);

    // Scenario 8b: Actual covers multiple installments worth of excess (e.g. Actual 60 000 ₽ vs Planned 30 000 ₽ -> Remaining 40 000 ₽)
    const calcLargeOverpay = calculateContractAndSchedule({
      purchaseCostKopecks: 8000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 25,
      downPaymentPercent: 30,
      useCustomActualDownPayment: true,
      actualDownPaymentKopecks: 6000000,
      termMonths: 5,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-10-31',
    });
    assert.equal(calcLargeOverpay.extraDownPaymentKopecks, 3000000);
    assert.equal(calcLargeOverpay.financedPrincipalKopecks, 4000000);
    assert.equal(
      calcLargeOverpay.schedule.reduce((s, i) => s + i.plannedKopecks, 0),
      4000000
    );

    // Scenario 9: Actual > Total Contract Debt -> Preview returns warning, Contract creation rejects
    const previewExceeds = await apiCall('/api/v1/contracts/preview', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 10500000, // 105 000 ₽ > 100 000 ₽ sale price
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(previewExceeds.status, 200);
    assert.equal(previewExceeds.data.exceedsTotalContractDebt, true);
    assert.equal(previewExceeds.data.excessOverContractKopecks, 500000);
    assert.ok(previewExceeds.data.warningMessage.includes('превышает общий долг по договору'));

    const createExceeds = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientId: 'cli_01',
        itemTitle: 'Тест превышения долга',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 10500000,
        confirmedCustomSchedule: true,
        confirmedCalculation: true,
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(createExceeds.status, 400);

    // Scenario 10: Negative or non-integer values are rejected
    assert.throws(() =>
      calculateContractAndSchedule({
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: -500,
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      })
    );
    assert.throws(() =>
      calculateContractAndSchedule({
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 1234.56,
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      })
    );

    // Scenario 11 & Full DB Transaction + Schedule History + Idempotency:
    // Require confirmedCustomSchedule when scheduleChanged is true
    const unconfirmedCustomRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientId: 'cli_01',
        itemTitle: 'Тест без подтверждения пересчёта',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 3500000,
        confirmedCustomSchedule: false,
        confirmedCalculation: true,
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(unconfirmedCustomRes.status, 400);

    // Confirmed creation with Actual = 35 000 ₽ (Planned = 30 000 ₽, Sale = 100 000 ₽)
    const customContractIdemKey = 'idem_custom_dp_35000_test';
    const createCustomOverpayRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: customContractIdemKey,
        clientId: 'cli_01',
        itemTitle: 'Холодильник Bosch (тест фактического ПВ 35 000 ₽)',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 3500000,
        confirmedCustomSchedule: true,
        confirmedCalculation: true,
        collectDownPaymentNow: true,
        downPaymentAccountId: 'acc_cash_main',
        downPaymentMethod: 'cash',
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(createCustomOverpayRes.status, 201);
    assert.equal(createCustomOverpayRes.data.plannedDownPaymentKopecks, 3000000);
    assert.equal(createCustomOverpayRes.data.actualDownPaymentKopecks, 3500000);
    assert.equal(createCustomOverpayRes.data.extraDownPaymentKopecks, 500000);
    assert.equal(createCustomOverpayRes.data.financedPrincipalKopecks, 6500000);
    assert.equal(createCustomOverpayRes.data.scheduleVersion, 2);

    // Duplicate request with same idempotencyKey must not create duplicate contract or payment
    const replayCustomOverpayRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: customContractIdemKey,
        clientId: 'cli_01',
        itemTitle: 'Холодильник Bosch (тест фактического ПВ 35 000 ₽)',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 3500000,
        confirmedCustomSchedule: true,
        confirmedCalculation: true,
        collectDownPaymentNow: true,
        downPaymentAccountId: 'acc_cash_main',
        downPaymentMethod: 'cash',
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(replayCustomOverpayRes.status, 200);
    assert.equal(replayCustomOverpayRes.data.idempotentReplay, true);
    assert.equal(replayCustomOverpayRes.data.id, createCustomOverpayRes.data.id);

    // Also test Shortfall contract with collectDownPaymentNow: true (Actual 20 000 ₽ vs Planned 30 000 ₽)
    const createCustomShortfallRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_custom_dp_20000_shortfall',
        clientId: 'cli_01',
        itemTitle: 'Телевизор Sony (тест недоплаты ПВ 20 000 ₽ вместо 30 000 ₽)',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        useCustomActualDownPayment: true,
        actualDownPaymentKopecks: 2000000,
        confirmedCustomSchedule: true,
        confirmedCalculation: true,
        collectDownPaymentNow: true,
        downPaymentAccountId: 'acc_cash_main',
        downPaymentMethod: 'cash',
        termMonths: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-31',
      },
    });
    assert.equal(createCustomShortfallRes.status, 201);
    assert.equal(createCustomShortfallRes.data.plannedDownPaymentKopecks, 3000000);
    assert.equal(createCustomShortfallRes.data.actualDownPaymentKopecks, 2000000);
    assert.equal(createCustomShortfallRes.data.downPaymentShortfallKopecks, 1000000);
    assert.equal(createCustomShortfallRes.data.financedPrincipalKopecks, 8000000);

    // Verify GET /api/v1/state has healthy reconciliation, schedule history (v1 superseded, v2 active), and accurate collected amounts
    const stateAfterCustomContracts = await apiCall('/api/v1/state', {
      sessionToken: ownerToken,
    });
    assert.equal(stateAfterCustomContracts.data.reconciliation.isHealthy, true);

    const overpayContract = stateAfterCustomContracts.data.contracts.find(
      (c: { id: string }) => c.id === createCustomOverpayRes.data.id
    );
    assert.ok(overpayContract);
    assert.equal(overpayContract.isCustomDownPayment, true);
    assert.equal(overpayContract.plannedDownPaymentKopecks, 3000000);
    assert.equal(overpayContract.actualDownPaymentKopecks, 3500000);
    assert.equal(overpayContract.extraDownPaymentKopecks, 500000);
    assert.equal(overpayContract.totalCollectedKopecks, 3500000);
    assert.equal(overpayContract.remainingDebtKopecks, 6500000);
    assert.equal(overpayContract.scheduleHistory.length, 2); // v1 planned + v2 adjusted

    const shortfallContract = stateAfterCustomContracts.data.contracts.find(
      (c: { id: string }) => c.id === createCustomShortfallRes.data.id
    );
    assert.ok(shortfallContract);
    assert.equal(shortfallContract.isCustomDownPayment, true);
    assert.equal(shortfallContract.plannedDownPaymentKopecks, 3000000);
    assert.equal(shortfallContract.actualDownPaymentKopecks, 2000000);
    assert.equal(shortfallContract.downPaymentShortfallKopecks, 1000000);
    // Shortfall (10 000 ₽) is NOT counted as collected income! Only 20 000 ₽ is collected.
    assert.equal(shortfallContract.totalCollectedKopecks, 2000000);
    assert.equal(shortfallContract.remainingDebtKopecks, 8000000);

    // =========================================================================
    // 13. Contract Form Upgrades: Client Switching, Manual Terms, Payment Day (1-31)
    // =========================================================================

    // Scenario 1: Switching from existing client to new client clears FIO, phone, passport, address, and guarantors
    const dirtyExistingState = {
      ...createInitialContractClientState(true),
      clientMode: 'existing' as const,
      clientId: createdClientId,
      clientNameQuery: 'Иванов Иван Иванович',
      payerLastName: 'Иванов',
      payerFirstName: 'Иван',
      payerPatronymic: 'Иванович',
      newClientPhone: '+7 (999) 111-22-33',
      newClientSecondaryPhone: '+7 (999) 222-33-44',
      newClientDocumentRef: '4510 123456',
      newClientAddress: 'г. Москва, ул. Тверская, д. 1',
      newClientNotes: 'Старый клиент',
      allowSimilarName: true,
      showSuggestions: true,
      guarantors: [
        {
          id: 'g-1',
          mode: 'existing' as const,
          clientId: 'some-guarantor-id',
          query: 'Петров Пётр',
          fullName: 'Петров Пётр',
          phone: '+79990001122',
          documentRef: '4511 654321',
          address: 'г. Москва',
          relationNote: 'Брат',
        },
      ],
    };

    const switchedToNew = switchContractFormToNewClient(dirtyExistingState);
    assert.equal(switchedToNew.clientMode, 'new');
    assert.equal(switchedToNew.clientId, '');
    assert.equal(switchedToNew.clientNameQuery, '');
    assert.equal(switchedToNew.payerLastName, '');
    assert.equal(switchedToNew.payerFirstName, '');
    assert.equal(switchedToNew.payerPatronymic, '');
    assert.equal(switchedToNew.newClientPhone, '');
    assert.equal(switchedToNew.newClientSecondaryPhone, '');
    assert.equal(switchedToNew.newClientDocumentRef, '');
    assert.equal(switchedToNew.newClientAddress, '');
    assert.equal(switchedToNew.newClientNotes, '');
    assert.equal(switchedToNew.allowSimilarName, false);
    assert.equal(switchedToNew.showSuggestions, false);
    assert.equal(switchedToNew.guarantors.length, 0);

    // Switching back to existing mode also clears draft new client inputs
    const switchedBackToExisting = switchContractFormToExistingClient(null);
    assert.equal(switchedBackToExisting.clientMode, 'existing');
    assert.equal(switchedBackToExisting.clientId, '');
    assert.equal(switchedBackToExisting.clientNameQuery, '');
    assert.equal(switchedBackToExisting.payerLastName, '');
    assert.equal(switchedBackToExisting.payerFirstName, '');
    assert.equal(switchedBackToExisting.newClientPhone, '');

    // API check: POST /api/v1/contracts with clientMode='new' ignores any stale clientId and creates a brand-new client
    const newClientSwitchApiRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientMode: 'new',
        clientId: createdClientId, // stale existing clientId should be ignored when clientMode === 'new'
        newClient: {
          fullName: 'Новиков Артём Сергеевич',
          phone: '+79995554433',
          documentRef: '4615 998877',
          address: 'г. Казань, ул. Баумана, д. 10',
        },
        itemTitle: 'Ноутбук ThinkPad X1',
        purchaseCostKopecks: 6000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        planId: null,
        markupPercent: 20,
        downPaymentPercent: 25,
        termMonths: 4,
        paymentDayOfMonth: 5,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-01-10',
        downPaymentAccountId: 'acc_bank_main',
        downPaymentMethod: 'bank_transfer',
        collectDownPaymentNow: true,
        confirmedCalculation: true,
      },
    });
    assert.equal(newClientSwitchApiRes.status, 201);
    assert.equal(newClientSwitchApiRes.data.paymentDayOfMonth, 5);

    const stateAfterNewClientContract = await apiCall('/api/v1/state', {
      sessionToken: ownerToken,
    });
    const createdManualContract = stateAfterNewClientContract.data.contracts.find(
      (c: { id: string }) => c.id === newClientSwitchApiRes.data.id
    );
    assert.ok(createdManualContract);
    assert.notEqual(createdManualContract.clientId, createdClientId);
    const createdNewClientRecord = stateAfterNewClientContract.data.clients.find(
      (cl: { id: string }) => cl.id === createdManualContract.clientId
    );
    assert.ok(createdNewClientRecord);
    assert.equal(createdNewClientRecord.fullName, 'Новиков Артём Сергеевич');

    // Scenario 2: Default tariff profile and cost fields (store price, delivery, extra costs) are empty when opening the form
    const initialTerms = createInitialContractTermsState();
    assert.equal(initialTerms.purchaseRubles, '');
    assert.equal(initialTerms.deliveryRubles, '');
    assert.equal(initialTerms.otherRubles, '');
    assert.equal(initialTerms.planId, '');
    assert.equal(initialTerms.termMonths, '');
    assert.equal(initialTerms.markupPercent, '');
    assert.equal(initialTerms.downPaymentPercent, '');
    assert.equal(initialTerms.paymentDayOfMonth, '');
    assert.equal(validateContractTermsState(initialTerms).valid, false);

    // Scenario 3: Creating contract without tariff profile using manually entered conditions
    assert.equal(createdManualContract.planId, null);
    assert.equal(createdManualContract.termMonths, 4);
    assert.equal(createdManualContract.markupPercent, 20);
    assert.equal(createdManualContract.downPaymentPercent, 25);
    assert.equal(createdManualContract.paymentDayOfMonth, 5);

    // Scenario 4: Selecting a tariff profile populates fields and allows manual override afterwards
    const filledFromTariff = applyTariffProfileToContractTerms(initialTerms, 'plan-6m', [
      {
        id: 'plan-6m',
        name: '6 месяцев · 25% · взнос 30%',
        termMonths: 6,
        markupPercent: 25,
        downPaymentPercent: 30,
        downPaymentRequired: true,
        earlyPayoffDiscountPercent: 5,
        roundingRule: 'kopeck',
        isActive: true,
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    assert.equal(filledFromTariff.planId, 'plan-6m');
    assert.equal(filledFromTariff.termMonths, '6');
    assert.equal(filledFromTariff.markupPercent, '25');
    assert.equal(filledFromTariff.downPaymentPercent, '30');

    const manuallyAdjustedAfterTariff = {
      ...filledFromTariff,
      markupPercent: '22.5',
      paymentDayOfMonth: '15',
    };
    const validatedAfterOverride = validateContractTermsState(manuallyAdjustedAfterTariff);
    assert.equal(validatedAfterOverride.valid, true);
    assert.equal(validatedAfterOverride.parsedMarkupPercent, 22.5);
    assert.equal(validatedAfterOverride.parsedPaymentDayOfMonth, 15);

    // Scenario 5: Schedule generation for chosen payment day (e.g. 5th of each month)
    assert.deepEqual(
      createdManualContract.schedule.map((item: { dueDate: string }) => item.dueDate),
      ['2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05']
    );

    // Scenario 6: Correct schedule generation for 29, 30, 31 in short months and leap years
    const calcShortMonthsNonLeap = calculateContractAndSchedule({
      purchaseCostKopecks: 4000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 20,
      downPaymentPercent: 25,
      termMonths: 4,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-01-31',
      paymentDayOfMonth: 31,
    });
    assert.deepEqual(
      calcShortMonthsNonLeap.schedule.map((s) => s.dueDate),
      ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']
    );

    const calcLeapYearFeb = calculateContractAndSchedule({
      purchaseCostKopecks: 3000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 20,
      downPaymentPercent: 20,
      termMonths: 3,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2028-01-15',
      paymentDayOfMonth: 31,
    });
    assert.deepEqual(
      calcLeapYearFeb.schedule.map((s) => s.dueDate),
      ['2028-02-29', '2028-03-31', '2028-04-30']
    );

    // Scenario 7: First payment is never placed in the past relative to startDate
    const calcNeverInPast = calculateContractAndSchedule({
      purchaseCostKopecks: 3000000,
      deliveryCostKopecks: 0,
      otherCostKopecks: 0,
      markupPercent: 20,
      downPaymentPercent: 20,
      termMonths: 3,
      roundingRule: 'kopeck',
      scheduleType: 'equal',
      startDate: '2026-01-20',
      paymentDayOfMonth: 5, // 5th of January 2026 is already in the past relative to 2026-01-20
    });
    assert.equal(calcNeverInPast.schedule[0].dueDate, '2026-02-05');
    assert.equal(calcNeverInPast.schedule[0].dueDate > '2026-01-20', true);

    // Scenario 8: Changing paymentDayOfMonth on an active contract preserves paid installments and updates unpaid ones
    const manualFirstInstallment = createdManualContract.schedule[0];
    const payFirstInstallmentRes = await apiCall('/api/v1/payments', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_payment_day_change_test_001',
        clientId: createdManualContract.clientId,
        contractId: createdManualContract.id,
        accountId: 'acc_bank_main',
        amountKopecks: manualFirstInstallment.plannedKopecks,
        paymentMethod: 'bank_transfer',
        eventDate: '2026-02-05',
        allocations: [
          {
            scheduleItemId: manualFirstInstallment.id,
            amountKopecks: manualFirstInstallment.plannedKopecks,
          },
        ],
      },
    });
    assert.equal(payFirstInstallmentRes.status, 201);

    const changePaymentDayRes = await apiCall(
      `/api/v1/contracts/${createdManualContract.id}/payment-day`,
      {
        method: 'PATCH',
        sessionToken: ownerToken,
        csrfToken: ownerCsrf,
        body: {
          paymentDayOfMonth: 20,
          reason: 'Перенос даты ежемесячного платежа на 20 число по просьбе клиента',
        },
      }
    );
    assert.equal(changePaymentDayRes.status, 200);
    assert.equal(changePaymentDayRes.data.paymentDayOfMonth, 20);
    assert.equal(changePaymentDayRes.data.updatedCount, 3);

    const stateAfterPaymentDayChange = await apiCall('/api/v1/state', {
      sessionToken: ownerToken,
    });
    const updatedManualContract = stateAfterPaymentDayChange.data.contracts.find(
      (c: { id: string }) => c.id === createdManualContract.id
    );
    assert.ok(updatedManualContract);
    assert.equal(updatedManualContract.paymentDayOfMonth, 20);
    // Paid 1st installment remains untouched on 2026-02-05, while unpaid installments 2, 3, 4 move to the 20th
    assert.equal(updatedManualContract.schedule[0].status, 'paid');
    assert.equal(updatedManualContract.schedule[0].dueDate, '2026-02-05');
    assert.deepEqual(
      updatedManualContract.schedule.slice(1).map((item: { dueDate: string }) => item.dueDate),
      ['2026-03-20', '2026-04-20', '2026-05-20']
    );

    // Direct unit check on recalculateUnpaidScheduleDates helper
    const unitRecalc = recalculateUnpaidScheduleDates(
      [
        {
          id: '1',
          installmentNumber: 1,
          dueDate: '2026-02-05',
          plannedKopecks: 1500000,
          paidKopecks: 1500000,
          status: 'paid',
        },
        {
          id: '2',
          installmentNumber: 2,
          dueDate: '2026-03-05',
          plannedKopecks: 1500000,
          paidKopecks: 0,
          status: 'pending',
        },
      ],
      '2026-01-10',
      25
    );
    assert.equal(unitRecalc[0].dueDate, '2026-02-05');
    assert.equal(unitRecalc[1].dueDate, '2026-03-25');

    // Scenario 9: Validation rejects empty or invalid payment day of month and invalid contract terms
    const invalidDayZeroRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientMode: 'existing',
        clientId: createdClientId,
        itemTitle: 'Тест неверного дня 0',
        purchaseCostKopecks: 2000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 20,
        downPaymentPercent: 20,
        termMonths: 3,
        paymentDayOfMonth: 0,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-01-10',
        confirmedCalculation: true,
      },
    });
    assert.equal(invalidDayZeroRes.status, 400);

    const invalidDay32Res = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientMode: 'existing',
        clientId: createdClientId,
        itemTitle: 'Тест неверного дня 32',
        purchaseCostKopecks: 2000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 20,
        downPaymentPercent: 20,
        termMonths: 3,
        paymentDayOfMonth: 32,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-01-10',
        confirmedCalculation: true,
      },
    });
    assert.equal(invalidDay32Res.status, 400);

    const invalidEmptyDayRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientMode: 'existing',
        clientId: createdClientId,
        itemTitle: 'Тест пустого дня платежа',
        purchaseCostKopecks: 2000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 20,
        downPaymentPercent: 20,
        termMonths: 3,
        paymentDayOfMonth: '',
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-01-10',
        confirmedCalculation: true,
      },
    });
    assert.equal(invalidEmptyDayRes.status, 400);

    const invalidPatchDayRes = await apiCall(
      `/api/v1/contracts/${createdManualContract.id}/payment-day`,
      {
        method: 'PATCH',
        sessionToken: ownerToken,
        csrfToken: ownerCsrf,
        body: {
          paymentDayOfMonth: 35,
        },
      }
    );
    assert.equal(invalidPatchDayRes.status, 400);

    // =========================================================================
    // 10. Безопасный главный экран (Welcome Screen) — проверка всех 7 сценариев
    // =========================================================================

    // Сценарий 1 и 7: Запуск приложения авторизованным пользователем (в т.ч. на медленном соединении)
    // открывает безопасный главный экран ('dashboard'), сессия проверяется через /api/v1/auth/session
    // без выдачи таблиц клиентов/договоров, а shouldLoadConfidentialState возвращает false.
    assert.equal(getSafeInitialLaunchSection(), 'dashboard');
    assert.equal(
      shouldLoadConfidentialState({
        isAuthenticated: true,
        activeSection: 'dashboard',
        hasOpenOperationalModal: false,
      }),
      false
    );
    const sessionCheckRes = await apiCall('/api/v1/auth/session', {
      method: 'GET',
      sessionToken: ownerToken,
    });
    assert.equal(sessionCheckRes.status, 200);
    assert.equal(sessionCheckRes.data.authenticated, true);
    assert.equal('clients' in sessionCheckRes.data, false);
    assert.equal('contracts' in sessionCheckRes.data, false);
    assert.equal('payments' in sessionCheckRes.data, false);

    // Сценарий 2: Перезагрузка страницы, когда ранее был открыт раздел клиентов или договоров —
    // не восстанавливает конфиденциальный раздел из URL-хэша или хранилища, снова открывает 'dashboard'.
    assert.equal(getSafeInitialLaunchSection('#clients', 'clients'), 'dashboard');
    assert.equal(getSafeInitialLaunchSection('#contracts', 'contracts'), 'dashboard');
    assert.equal(getSafeInitialLaunchSection('#payments', 'payments'), 'dashboard');

    // Сценарий 3: Вход в приложение по логину и паролю — открывается главный экран приветствия с именем пользователя.
    assert.equal(
      formatWelcomeGreeting(sessionCheckRes.data.user.fullName),
      `Добро пожаловать, ${sessionCheckRes.data.user.fullName}`
    );
    assert.equal(formatWelcomeGreeting(''), 'Добро пожаловать');

    // Сценарий 4: Переход через меню в разделы «Клиенты», «Договоры», «Платежи» —
    // активирует загрузку данных и возвращает все таблицы и функции в рабочем состоянии.
    assert.equal(
      shouldLoadConfidentialState({
        isAuthenticated: true,
        activeSection: 'clients',
      }),
      true
    );
    assert.equal(
      shouldLoadConfidentialState({
        isAuthenticated: true,
        activeSection: 'contracts',
      }),
      true
    );
    assert.equal(
      shouldLoadConfidentialState({
        isAuthenticated: true,
        activeSection: 'payments',
      }),
      true
    );
    const protectedSectionState = await apiCall('/api/v1/state', {
      method: 'GET',
      sessionToken: ownerToken,
    });
    assert.equal(protectedSectionState.status, 200);
    assert.ok(Array.isArray(protectedSectionState.data.clients));
    assert.ok(Array.isArray(protectedSectionState.data.contracts));
    assert.ok(Array.isArray(protectedSectionState.data.payments));

    // Сценарий 5: Попытка открыть внутренний раздел без авторизации — отклоняется (401) и перенаправляет на вход.
    assert.equal(
      shouldLoadConfidentialState({
        isAuthenticated: false,
        activeSection: 'clients',
      }),
      false
    );
    const unauthStateRes = await apiCall('/api/v1/state', {
      method: 'GET',
    });
    assert.equal(unauthStateRes.status, 401);

    // Сценарий 6: Выход из аккаунта — сессия очищается, повторный доступ к внутренним разделам закрыт (401).
    const ownerLogoutRes = await apiCall('/api/v1/auth/logout', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(ownerLogoutRes.status, 200);
    const afterOwnerLogoutSession = await apiCall('/api/v1/auth/session', {
      method: 'GET',
      sessionToken: ownerToken,
    });
    assert.equal(afterOwnerLogoutSession.data.authenticated, false);
    const afterOwnerLogoutState = await apiCall('/api/v1/state', {
      method: 'GET',
      sessionToken: ownerToken,
    });
    assert.equal(afterOwnerLogoutState.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


