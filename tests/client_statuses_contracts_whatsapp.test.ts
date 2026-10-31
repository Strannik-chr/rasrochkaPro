import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../server';
import {
  DEFAULT_STATUS_RULES,
  evaluateClientOverallStatus,
  evaluateContractStatus,
  buildWhatsAppClickToChatUrl,
  formatTelHref,
  type ContractEvalInput,
} from '../src/shared/clientStatus';
import { validateUploadedFileSignature } from '../src/server/security/crypto';

test('Unit & Domain: Все 5 статусов («VIP», «Надёжный», «Под наблюдением», «Сложный», «Рассрочка закрыта») + нейтральный «Новый клиент»', () => {
  // 1. Клиент без договоров НЕ получает VIP автоматически -> 'new'
  const emptyClientEval = evaluateClientOverallStatus([], DEFAULT_STATUS_RULES);
  assert.equal(emptyClientEval.status, 'new');
  assert.equal(emptyClientEval.activeContractsCount, 0);
  assert.equal(emptyClientEval.completedContractsCount, 0);

  // 2. Договор без просрочек и задержек -> 'vip'
  const vipContractInput: ContractEvalInput = {
    id: 'cnt_vip',
    contractNumber: 'ДГ-2026-0001',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 1000000,
    overdueKopecks: 0,
    schedule: [
      {
        id: 'si_1',
        installmentNumber: 1,
        dueDate: '2026-09-29',
        originalDueDate: '2026-09-29',
        plannedKopecks: 1000000,
        paidKopecks: 1000000,
        remainingKopecks: 0,
        status: 'paid',
        daysOverdue: 0,
        lastPaidEventDate: '2026-09-28',
      },
      {
        id: 'si_2',
        installmentNumber: 2,
        dueDate: '2026-11-29',
        originalDueDate: '2026-11-29',
        plannedKopecks: 1000000,
        paidKopecks: 0,
        remainingKopecks: 1000000,
        status: 'pending',
        daysOverdue: 0,
      },
    ],
  };
  const vipContract = evaluateContractStatus(vipContractInput, DEFAULT_STATUS_RULES);
  assert.equal(vipContract.status, 'vip');
  assert.equal(vipContract.nextPaymentDate, '2026-11-29');

  // 3. Договор, где ранее была небольшая задержка или перенос срока, но сейчас долга по просрочке нет -> 'reliable' («Надёжный»)
  const reliableContractInput: ContractEvalInput = {
    id: 'cnt_rel',
    contractNumber: 'ДГ-2026-0002',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 1000000,
    overdueKopecks: 0,
    schedule: [
      {
        id: 'si_r1',
        installmentNumber: 1,
        dueDate: '2026-09-10',
        originalDueDate: '2026-09-01', // перенос срока платежа
        plannedKopecks: 1000000,
        paidKopecks: 1000000,
        remainingKopecks: 0,
        status: 'paid',
        daysOverdue: 0,
      },
      {
        id: 'si_r2',
        installmentNumber: 2,
        dueDate: '2026-11-10',
        originalDueDate: '2026-11-10',
        plannedKopecks: 1000000,
        paidKopecks: 0,
        remainingKopecks: 1000000,
        status: 'pending',
        daysOverdue: 0,
      },
    ],
  };
  const reliableContract = evaluateContractStatus(reliableContractInput, DEFAULT_STATUS_RULES);
  assert.equal(reliableContract.status, 'reliable');

  // 4. В течение первых дней (< 3 дней после наступления даты оплаты) статус НЕ ухудшается,
  // а если в течение 3 дней после наступления даты оплаты не заплатил (daysOverdue >= 3) -> статус меняется на 'watch' («Под наблюдением»)
  const day2GraceContractInput: ContractEvalInput = {
    id: 'cnt_grace_2d',
    contractNumber: 'ДГ-2026-0003А',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 1000000,
    overdueKopecks: 0,
    schedule: [
      {
        id: 'si_g2',
        installmentNumber: 1,
        dueDate: '2026-10-29',
        originalDueDate: '2026-10-29',
        plannedKopecks: 1000000,
        paidKopecks: 0,
        remainingKopecks: 1000000,
        status: 'pending',
        daysOverdue: 2, // 2 дня после даты оплаты (< 3 дней)
      },
    ],
  };
  const day2GraceContract = evaluateContractStatus(day2GraceContractInput, DEFAULT_STATUS_RULES);
  assert.equal(day2GraceContract.status, 'vip');

  const day3OverdueContractInput: ContractEvalInput = {
    id: 'cnt_overdue_3d',
    contractNumber: 'ДГ-2026-0003Б',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 1000000,
    overdueKopecks: 1000000,
    schedule: [
      {
        id: 'si_o3',
        installmentNumber: 1,
        dueDate: '2026-10-28',
        originalDueDate: '2026-10-28',
        plannedKopecks: 1000000,
        paidKopecks: 0,
        remainingKopecks: 1000000,
        status: 'overdue',
        daysOverdue: 3, // ровно 3 дня после даты оплаты не заплатил -> статус меняется на 'watch'
      },
    ],
  };
  const day3OverdueContract = evaluateContractStatus(day3OverdueContractInput, DEFAULT_STATUS_RULES);
  assert.equal(day3OverdueContract.status, 'watch');

  // Частичная оплата просроченного платежа НЕ считается полным погашением -> 'watch' («Под наблюдением»)
  const watchContractInput: ContractEvalInput = {
    id: 'cnt_watch',
    contractNumber: 'ДГ-2026-0003',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 1000000,
    overdueKopecks: 1000000,
    schedule: [
      {
        id: 'si_w1',
        installmentNumber: 1,
        dueDate: '2026-10-22', // 7 дней просрочки (< 15 дней для «Сложный»)
        originalDueDate: '2026-10-22',
        plannedKopecks: 1500000,
        paidKopecks: 500000, // частичная оплата
        remainingKopecks: 1000000, // 10 000 руб. (< 30 000 руб.)
        status: 'partial',
        daysOverdue: 7,
      },
    ],
  };
  const watchContract = evaluateContractStatus(watchContractInput, DEFAULT_STATUS_RULES);
  assert.equal(watchContract.status, 'watch');
  assert.equal(watchContract.effectiveOverdueKopecks, 1000000);

  // 5. Длительная просрочка (>= 15 дней) или >= 2 пропущенных платежей подряд -> 'complex' («Сложный»)
  const complexContractInput: ContractEvalInput = {
    id: 'cnt_complex',
    contractNumber: 'ДГ-2026-0004',
    status: 'active',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 2400000,
    overdueKopecks: 2400000,
    schedule: [
      {
        id: 'si_c1',
        installmentNumber: 1,
        dueDate: '2026-09-15',
        originalDueDate: '2026-09-15',
        plannedKopecks: 1200000,
        paidKopecks: 0,
        remainingKopecks: 1200000,
        status: 'overdue',
        daysOverdue: 44,
      },
      {
        id: 'si_c2',
        installmentNumber: 2,
        dueDate: '2026-10-15',
        originalDueDate: '2026-10-15',
        plannedKopecks: 1200000,
        paidKopecks: 0,
        remainingKopecks: 1200000,
        status: 'overdue',
        daysOverdue: 14,
      },
    ],
  };
  const complexContract = evaluateContractStatus(complexContractInput, DEFAULT_STATUS_RULES);
  assert.equal(complexContract.status, 'complex');

  // 6. Исполненный договор -> 'closed' («Рассрочка закрыта»)
  const closedContractInput: ContractEvalInput = {
    id: 'cnt_closed',
    contractNumber: 'ДГ-2026-0005',
    status: 'completed',
    currentScheduleVersion: 1,
    remainingDebtKopecks: 0,
    overdueKopecks: 0,
    schedule: [
      {
        id: 'si_cl1',
        installmentNumber: 1,
        dueDate: '2026-08-15',
        originalDueDate: '2026-08-15',
        plannedKopecks: 2000000,
        paidKopecks: 2000000,
        remainingKopecks: 0,
        status: 'paid',
        daysOverdue: 0,
        lastPaidEventDate: '2026-08-15',
      },
    ],
  };
  const closedContract = evaluateContractStatus(closedContractInput, DEFAULT_STATUS_RULES);
  assert.equal(closedContract.status, 'closed');

  // 7. Если клиент закрыл один договор ('closed'), но имеет второй активный ('watch'), общий статус клиента -> 'watch'
  const multiContractClient = evaluateClientOverallStatus(
    [closedContractInput, watchContractInput],
    DEFAULT_STATUS_RULES
  );
  assert.equal(multiContractClient.status, 'watch');
  assert.equal(multiContractClient.activeContractsCount, 1);
  assert.equal(multiContractClient.completedContractsCount, 1);

  // 8. Если у клиента нет активных договоров, но есть завершённый -> 'closed' («Рассрочка закрыта»)
  const allClosedClient = evaluateClientOverallStatus(
    [closedContractInput],
    DEFAULT_STATUS_RULES
  );
  assert.equal(allClosedClient.status, 'closed');
});

test('Unit: Проверка сигнатур файлов договора (JPEG, PNG, WebP, PDF) и отклонение неподдерживаемых типов', () => {
  // Valid WebP magic bytes: RIFF....WEBP
  const webpBuf = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x24, 0x00, 0x00, 0x00, // size
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x20,
  ]);
  const webpRes = validateUploadedFileSignature(webpBuf, 'image/webp', 'contract_photo.webp');
  assert.equal(webpRes.valid, true);
  assert.equal(webpRes.detectedMime, 'image/webp');

  // Valid JPEG magic bytes: FF D8 FF E0
  const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const jpgRes = validateUploadedFileSignature(jpgBuf, 'image/jpeg', 'scan.jpg');
  assert.equal(jpgRes.valid, true);
  assert.equal(jpgRes.detectedMime, 'image/jpeg');

  // Valid PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const pngRes = validateUploadedFileSignature(pngBuf, 'image/png', 'page1.png');
  assert.equal(pngRes.valid, true);
  assert.equal(pngRes.detectedMime, 'image/png');

  // Valid PDF magic bytes: %PDF-1.7
  const pdfBuf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'utf8');
  const pdfRes = validateUploadedFileSignature(pdfBuf, 'application/pdf', 'agreement.pdf');
  assert.equal(pdfRes.valid, true);
  assert.equal(pdfRes.detectedMime, 'application/pdf');

  // Unsupported extension (.exe / .html) or spoofed signature -> rejected
  const spoofedBuf = Buffer.from('MZ_executable_payload_123456', 'utf8');
  const badExtRes = validateUploadedFileSignature(spoofedBuf, 'application/octet-stream', 'malware.exe');
  assert.equal(badExtRes.valid, false);

  const spoofedPdfRes = validateUploadedFileSignature(spoofedBuf, 'application/pdf', 'fake.pdf');
  assert.equal(spoofedPdfRes.valid, false);
});

test('Unit: Формирование ссылок WhatsApp Click to Chat и быстрого звонка tel:', () => {
  const waUrl = buildWhatsAppClickToChatUrl('8 (928) 777-88-99', 'Здравствуйте! Договор № ДГ-2026-0005');
  assert.ok(waUrl);
  assert.ok(waUrl.startsWith('https://wa.me/79287778899?text='));

  const invalidWaUrl = buildWhatsAppClickToChatUrl('12345', 'Тест');
  assert.equal(invalidWaUrl, null);

  assert.equal(formatTelHref('8 (928) 777-88-99'), 'tel:+79287778899');
  assert.equal(formatTelHref('некорректный'), null);
});

test('HTTP Integration: Все 15 пользовательских сценариев (договоры, новые клиенты, защита от дубликатов, файлы, статусы, WhatsApp, звонки)', async () => {
  const { app } = await createAppServer(':memory:');
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
    // Авторизация владельца
    const ownerLogin = await apiCall('/api/v1/auth/login', {
      method: 'POST',
      body: { phone: '+79285550101', password: 'MoOwner!2026' },
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = ownerLogin.data.sessionToken;
    const ownerCsrf = ownerLogin.data.csrfToken;

    // Сценарий 1: Создание договора с выбором существующего клиента (cli_01)
    const existingClientContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_test_existing_client_01',
        clientId: 'cli_01',
        itemTitle: 'Планшет iPad Air M2 256GB',
        purchaseCostKopecks: 6000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 30,
        termMonths: 6,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-01',
        collectDownPaymentNow: true,
        confirmedCalculation: true,
      },
    });
    assert.equal(existingClientContractRes.status, 201);
    assert.equal(existingClientContractRes.data.clientId, 'cli_01');
    assert.equal(existingClientContractRes.data.createdNewClient, false);

    // Проверка идемпотентности при повторном нажатии кнопки сохранения договора
    const replayContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_test_existing_client_01',
        clientId: 'cli_01',
        itemTitle: 'Планшет iPad Air M2 256GB',
        purchaseCostKopecks: 6000000,
        confirmedCalculation: true,
      },
    });
    assert.equal(replayContractRes.status, 200);
    assert.equal(replayContractRes.data.idempotentReplay, true);
    assert.equal(replayContractRes.data.id, existingClientContractRes.data.id);

    // Сценарий 2, 4 и 5: Создание договора с вводом НОВОГО клиента прямо в форме договора + прикрепление WebP-фото и PDF-скана договора
    const validWebpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20,
    ]);
    const validPdfBuffer = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'utf8');

    const newClientWithFilesContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_test_new_client_with_docs_02',
        newClient: {
          fullName: 'Сулейманов Тимур Русланович',
          phone: '8 (928) 444-55-66',
          documentRef: '82 19 654321',
          address: 'г. Каспийск, ул. Ленина, 35',
        },
        itemTitle: 'Ноутбук ASUS Zenbook 14 OLED',
        purchaseCostKopecks: 8000000,
        deliveryCostKopecks: 0,
        otherCostKopecks: 0,
        markupPercent: 25,
        downPaymentPercent: 25,
        termMonths: 4,
        roundingRule: 'kopeck',
        scheduleType: 'equal',
        startDate: '2026-10-15',
        collectDownPaymentNow: true,
        confirmedCalculation: true,
        attachments: [
          {
            title: 'Фото подписанного договора (стр. 1)',
            originalFilename: 'dogovor_page1.webp',
            mimeType: 'image/webp',
            contentBase64: validWebpBuffer.toString('base64'),
          },
          {
            title: 'Скан подписанного договора PDF',
            originalFilename: 'dogovor_full.pdf',
            mimeType: 'application/pdf',
            contentBase64: validPdfBuffer.toString('base64'),
          },
        ],
      },
    });
    assert.equal(newClientWithFilesContractRes.status, 201);
    assert.equal(newClientWithFilesContractRes.data.createdNewClient, true);
    assert.equal(newClientWithFilesContractRes.data.documentIds.length, 2);
    const createdTimurClientId = newClientWithFilesContractRes.data.clientId;
    const createdTimurContractId = newClientWithFilesContractRes.data.id;
    const attachedWebpDocId = newClientWithFilesContractRes.data.documentIds[0];

    // Сценарий 3: Защита от дублирования клиентов по номеру телефона и ФИО при создании договора
    const dupCheckEndpoint = await apiCall(
      `/api/v1/clients/check-duplicates?phone=${encodeURIComponent('+7 (928) 444-55-66')}&fullName=${encodeURIComponent('Сулейманов Тимур')}`,
      { sessionToken: ownerToken }
    );
    assert.equal(dupCheckEndpoint.status, 200);
    assert.equal(dupCheckEndpoint.data.exactPhoneMatches.length, 1);
    assert.equal(dupCheckEndpoint.data.exactPhoneMatches[0].id, createdTimurClientId);

    const dupPhoneContractAttempt = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        newClient: {
          fullName: 'Другой Человек С Тем Же Номером',
          phone: '+7-928-444-55-66',
        },
        itemTitle: 'Смартфон Xiaomi 14',
        purchaseCostKopecks: 4000000,
        confirmedCalculation: true,
      },
    });
    assert.equal(dupPhoneContractAttempt.status, 409);
    assert.equal(dupPhoneContractAttempt.data.duplicateClient.id, createdTimurClientId);

    const dupNameContractAttempt = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        newClient: {
          fullName: 'Сулейманов Тимур Русланович',
          phone: '+79284449900',
          allowSimilarName: false,
        },
        itemTitle: 'Смартфон Xiaomi 14',
        purchaseCostKopecks: 4000000,
        confirmedCalculation: true,
      },
    });
    assert.equal(dupNameContractAttempt.status, 409);
    assert.equal(dupNameContractAttempt.data.similarClients.length, 1);

    // Сценарий 6: Отклонение файла неподдерживаемого типа при создании договора или загрузке документа
    const badAttachmentContractRes = await apiCall('/api/v1/contracts', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        clientId: createdTimurClientId,
        itemTitle: 'Тест Неверного Файла',
        purchaseCostKopecks: 2000000,
        confirmedCalculation: true,
        attachments: [
          {
            originalFilename: 'script.exe',
            mimeType: 'application/octet-stream',
            contentBase64: Buffer.from('MZ_bad_executable').toString('base64'),
          },
        ],
      },
    });
    assert.equal(badAttachmentContractRes.status, 400);

    // Сценарий 7: Просмотр (preview), скачивание (download) и безопасная замена (replace) прикреплённого договора без потери старого файла
    const previewRes = await apiCall(`/api/v1/documents/${attachedWebpDocId}/preview`, {
      sessionToken: ownerToken,
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.headers.get('content-type'), 'image/webp');
    assert.ok(previewRes.headers.get('content-disposition')?.includes('inline'));

    const validJpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const replaceDocRes = await apiCall(`/api/v1/documents/${attachedWebpDocId}/replace`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        title: 'Обновлённое фото договора (высокое качество)',
        originalFilename: 'dogovor_page1_hd.jpg',
        mimeType: 'image/jpeg',
        contentBase64: validJpegBuffer.toString('base64'),
      },
    });
    assert.equal(replaceDocRes.status, 201);
    assert.equal(replaceDocRes.data.previousDocumentId, attachedWebpDocId);
    const replacementDocId = replaceDocRes.data.id;

    // Убеждаемся, что старый документ сохранён в архиве (isArchived === true) и доступен для скачивания
    const oldDocDownload = await apiCall(`/api/v1/documents/${attachedWebpDocId}/download`, {
      sessionToken: ownerToken,
    });
    assert.equal(oldDocDownload.status, 200);

    // Сценарии 8–13: Проверка статусов клиентов («VIP», «Надёжный», «Под наблюдением», «Сложный», «Рассрочка закрыта», «Новый клиент») и настройки порогов
    // Создадим клиента без договоров -> должен получить статус 'new' (а НЕ 'vip')
    const clientNoContractsRes = await apiCall('/api/v1/clients', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        fullName: 'Курбанов Арсен Маратович',
        phone: '+79281002030',
      },
    });
    assert.equal(clientNoContractsRes.status, 201);
    const arsenClientId = clientNoContractsRes.data.id;

    const stateCheck1 = await apiCall('/api/v1/state', { sessionToken: ownerToken });
    assert.equal(stateCheck1.status, 200);

    const arsenInState = stateCheck1.data.clients.find((c: any) => c.id === arsenClientId);
    assert.equal(arsenInState.paymentStatus, 'new');

    // Тимур Сулейманов имеет новый активный договор без просрочек -> статус 'vip'
    const timurInState = stateCheck1.data.clients.find((c: any) => c.id === createdTimurClientId);
    assert.equal(timurInState.paymentStatus, 'vip');
    assert.equal(timurInState.activeContractsCount, 1);

    // Исмаилов Камиль (cli_02 из начальных данных) имеет текущую просрочку -> 'watch' или 'complex'
    const kamilInState = stateCheck1.data.clients.find((c: any) => c.id === 'cli_02');
    assert.ok(['watch', 'complex'].includes(kamilInState.paymentStatus));
    assert.ok(kamilInState.overdueDebtKopecks > 0);

    // Полностью погасим все платежи по договору Тимура Сулейманова -> договор и клиент переходят в статус 'closed' («Рассрочка закрыта»)
    const timurContractInState = stateCheck1.data.contracts.find(
      (c: any) => c.id === createdTimurContractId
    );
    const remainingForTimur = timurContractInState.remainingDebtKopecks;
    const allocationsForTimur = timurContractInState.schedule.map((si: any) => ({
      scheduleItemId: si.id,
      amountKopecks: si.remainingKopecks,
    }));

    const fullPayRes = await apiCall('/api/v1/payments', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        idempotencyKey: 'idem_full_pay_timur_01',
        clientId: createdTimurClientId,
        contractId: createdTimurContractId,
        accountId: 'acc_bank_main',
        paymentMethod: 'bank_transfer',
        amountKopecks: remainingForTimur,
        eventDate: '2026-10-20',
        allocations: allocationsForTimur,
      },
    });
    assert.equal(fullPayRes.status, 201);

    const stateCheckAfterPayoff = await apiCall('/api/v1/state', { sessionToken: ownerToken });
    const timurContractAfter = stateCheckAfterPayoff.data.contracts.find(
      (c: any) => c.id === createdTimurContractId
    );
    assert.equal(timurContractAfter.status, 'completed');
    assert.equal(timurContractAfter.computedStatus, 'closed');

    const timurClientAfter = stateCheckAfterPayoff.data.clients.find(
      (c: any) => c.id === createdTimurClientId
    );
    assert.equal(timurClientAfter.paymentStatus, 'closed');
    assert.equal(timurClientAfter.activeContractsCount, 0);
    assert.equal(timurClientAfter.completedContractsCount, 1);

    // Изменение порогов статусов администратором через PUT /api/v1/settings/status-rules
    const updateRulesRes = await apiCall('/api/v1/settings/status-rules', {
      method: 'PUT',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
      body: {
        gracePeriodDays: 2,
        complexMinOverdueDays: 10,
        complexConsecutiveMissedCount: 2,
        complexMinOverdueKopecks: 2000000,
        reliableMaxPastLateCount: 3,
      },
    });
    assert.equal(updateRulesRes.status, 200);
    assert.equal(updateRulesRes.data.gracePeriodDays, 2);
    assert.equal(updateRulesRes.data.complexMinOverdueDays, 10);

    // Сценарии 14 и 15: Подготовка отправки договора через WhatsApp и быстрый звонок клиенту
    const waPrepRes = await apiCall(
      `/api/v1/contracts/${createdTimurContractId}/prepare-whatsapp`,
      {
        method: 'POST',
        sessionToken: ownerToken,
        csrfToken: ownerCsrf,
        body: {
          documentId: replacementDocId,
        },
      }
    );
    assert.equal(waPrepRes.status, 200);
    assert.equal(waPrepRes.data.normalizedPhone, '+79284445566');
    assert.ok(waPrepRes.data.whatsappUrl.startsWith('https://wa.me/79284445566?text='));
    assert.equal(waPrepRes.data.telHref, 'tel:+79284445566');
    assert.equal(
      waPrepRes.data.statusNotice,
      'Чат открыт. Прикрепите договор и отправьте сообщение'
    );
    assert.equal(waPrepRes.data.hasAttachedDocument, true);
    assert.equal(waPrepRes.data.selectedDocument.id, replacementDocId);

    // Сценарий 16 (Production Persistence & Upgrade Safety):
    // Создание резервной копии и восстановление сохраняют все прикреплённые фото/сканы договоров и настройки статусов
    const backupCreateRes = await apiCall('/api/v1/security/backups', {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(backupCreateRes.status, 201);
    const createdBackupId = backupCreateRes.data.id;

    const backupRestoreRes = await apiCall(`/api/v1/security/backups/${createdBackupId}/restore`, {
      method: 'POST',
      sessionToken: ownerToken,
      csrfToken: ownerCsrf,
    });
    assert.equal(backupRestoreRes.status, 200);
    assert.equal(backupRestoreRes.data.restored, true);

    // После восстановления фото договора и пороги статусов полностью сохранены
    const previewAfterRestore = await apiCall(`/api/v1/documents/${replacementDocId}/preview`, {
      sessionToken: ownerToken,
    });
    assert.equal(previewAfterRestore.status, 200);
    assert.equal(previewAfterRestore.headers.get('content-type'), 'image/jpeg');

    const rulesAfterRestore = await apiCall('/api/v1/settings/status-rules', {
      sessionToken: ownerToken,
    });
    assert.equal(rulesAfterRestore.status, 200);
    assert.equal(rulesAfterRestore.data.gracePeriodDays, 2);
    assert.equal(rulesAfterRestore.data.complexMinOverdueDays, 10);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
