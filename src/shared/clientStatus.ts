import { ClientPaymentStatus, StatusRulesConfigDTO } from './types';

export const DEFAULT_STATUS_RULES: StatusRulesConfigDTO = {
  gracePeriodDays: 3,
  complexMinOverdueDays: 15,
  complexConsecutiveMissedCount: 2,
  complexMinOverdueKopecks: 3000000, // 30 000,00 ₽
  reliableMaxPastLateCount: 3,
  updatedAt: '2026-07-01T00:00:00.000Z',
};

export const PAYMENT_STATUS_SEVERITY: Record<ClientPaymentStatus, number> = {
  complex: 5,
  watch: 4,
  reliable: 3,
  vip: 2,
  closed: 1,
  new: 0,
};

export function translateClientPaymentStatus(status?: ClientPaymentStatus): string {
  switch (status) {
    case 'vip':
      return 'VIP';
    case 'reliable':
      return 'Надёжный';
    case 'watch':
      return 'Под наблюдением';
    case 'complex':
      return 'Сложный';
    case 'closed':
      return 'Рассрочка закрыта';
    case 'new':
    default:
      return 'Новый клиент';
  }
}

/**
 * Normalizes a Russian phone number into canonical E.164 format (+7XXXXXXXXXX).
 * Safe for both frontend and backend usage.
 */
export function normalizePhoneE164(rawInput: unknown): string | null {
  if (typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  if (!/^[+\d\s()\-]+$/.test(trimmed)) {
    return null;
  }
  if (trimmed.includes('+') && !trimmed.startsWith('+')) {
    return null;
  }

  const digits = trimmed.replace(/\D/g, '');
  let subscriberDigits = '';
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    if (trimmed.startsWith('+8')) {
      return null;
    }
    subscriberDigits = digits.slice(1);
  } else if (digits.length === 10 && !trimmed.startsWith('+')) {
    subscriberDigits = digits;
  } else {
    return null;
  }

  if (!/^[3489]\d{9}$/.test(subscriberDigits)) {
    return null;
  }

  return `+7${subscriberDigits}`;
}

/**
 * Formats a phone number into a safe `tel:+7XXXXXXXXXX` URI.
 * Returns null if the phone number is missing or invalid.
 */
export function formatTelHref(rawPhone: unknown): string | null {
  const e164 = normalizePhoneE164(rawPhone);
  if (!e164) return null;
  return `tel:${e164}`;
}

/**
 * Formats a phone number into international digits without '+' for WhatsApp Click to Chat (e.g. "79285550101").
 * Returns null if the phone number is missing or invalid.
 */
export function formatWhatsAppPhoneDigits(rawPhone: unknown): string | null {
  const e164 = normalizePhoneE164(rawPhone);
  if (!e164) return null;
  return e164.replace(/^\+/, '');
}

/**
 * Builds an official WhatsApp Click to Chat URL (`https://wa.me/7XXXXXXXXXX?text=...`).
 * Returns null if the phone number is invalid.
 */
export function buildWhatsAppClickToChatUrl(rawPhone: unknown, messageText: string): string | null {
  const digits = formatWhatsAppPhoneDigits(rawPhone);
  if (!digits) return null;
  const cleanText = (messageText || '').trim();
  if (!cleanText) return `https://wa.me/${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(cleanText)}`;
}

/**
 * Builds a direct WhatsApp chat URL (`https://wa.me/7XXXXXXXXXX`) to open a chat with the client immediately.
 */
export function buildDirectWhatsAppUrl(rawPhone: unknown, messageText?: string): string | null {
  const digits = formatWhatsAppPhoneDigits(rawPhone);
  if (!digits) return null;
  const cleanText = (messageText || '').trim();
  return cleanText
    ? `https://wa.me/${digits}?text=${encodeURIComponent(cleanText)}`
    : `https://wa.me/${digits}`;
}

/**
 * Builds a polite, clear pre-filled message for sending a contract copy via WhatsApp.
 */
export function buildContractWhatsAppMessage(params: {
  clientName: string;
  contractNumber: string;
  itemTitle: string;
  startDate: string;
  salePriceRublesFormatted?: string;
}): string {
  const greetingName = (params.clientName || '').trim();
  const baseGreeting = greetingName ? `Здравствуйте, ${greetingName}!` : 'Здравствуйте!';
  const details = params.contractNumber
    ? `Отправляю вам копию вашего договора №${params.contractNumber} от ${params.startDate} (${params.itemTitle}).`
    : 'Отправляю вам копию вашего договора.';
  return `${baseGreeting} ${details} Если возникнут вопросы, свяжитесь со мной.`;
}

export interface ScheduleItemEvalInput {
  id: string;
  installmentNumber: number;
  dueDate: string;
  originalDueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  remainingKopecks: number;
  status: string;
  daysOverdue: number;
  lastPaidEventDate?: string | null;
}

export interface ContractEvalInput {
  id: string;
  contractNumber: string;
  status: string;
  currentScheduleVersion: number;
  remainingDebtKopecks: number;
  overdueKopecks: number;
  schedule: ScheduleItemEvalInput[];
}

export interface ComputedStatusResult {
  status: ClientPaymentStatus;
  label: string;
  reason: string;
  effectiveOverdueKopecks: number;
  maxEffectiveDaysOverdue: number;
  consecutiveOverdueCount: number;
  pastLateCount: number;
  nextPaymentDate: string | null;
  nextPaymentAmountKopecks: number;
}

function diffDaysBetweenIsoDates(dueDateIso: string, paidDateIso: string): number {
  const due = new Date(`${dueDateIso.slice(0, 10)}T00:00:00Z`).getTime();
  const paid = new Date(`${paidDateIso.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(due) || Number.isNaN(paid) || paid <= due) return 0;
  return Math.floor((paid - due) / (1000 * 60 * 60 * 24));
}

function formatKopecksShort(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/**
 * Evaluates a single contract's status based on its active schedule, real payment allocations,
 * and configurable status rules.
 */
export function evaluateContractStatus(
  contract: ContractEvalInput,
  rules: StatusRulesConfigDTO = DEFAULT_STATUS_RULES
): ComputedStatusResult {
  const graceDays = Math.max(0, Math.trunc(Number(rules.gracePeriodDays ?? 3)));
  const overdueThresholdDays = Math.max(1, graceDays);

  if (contract.status === 'completed' && contract.remainingDebtKopecks <= 0) {
    let pastLateCount = 0;
    for (const item of contract.schedule) {
      if (item.lastPaidEventDate) {
        const lateDays = diffDaysBetweenIsoDates(item.dueDate, item.lastPaidEventDate);
        if (lateDays >= overdueThresholdDays) {
          pastLateCount++;
        }
      }
    }
    return {
      status: 'closed',
      label: translateClientPaymentStatus('closed'),
      reason: `Все обязательства по договору ${contract.contractNumber} полностью выполнены (остаток долга 0,00 ₽).`,
      effectiveOverdueKopecks: 0,
      maxEffectiveDaysOverdue: 0,
      consecutiveOverdueCount: 0,
      pastLateCount,
      nextPaymentDate: null,
      nextPaymentAmountKopecks: 0,
    };
  }

  const sortedSchedule = [...contract.schedule].sort(
    (a, b) => a.installmentNumber - b.installmentNumber
  );

  let effectiveOverdueKopecks = 0;
  let maxEffectiveDaysOverdue = 0;
  let currentStreak = 0;
  let maxConsecutiveOverdueCount = 0;
  let pastLateCount = 0;
  let inGracePeriodCount = 0;
  let maxGraceDaysElapsed = 0;
  let nextPaymentDate: string | null = null;
  let nextPaymentAmountKopecks = 0;

  for (const item of sortedSchedule) {
    if (item.status === 'superseded' || item.status === 'waived') continue;

    const remaining = Math.max(0, item.plannedKopecks - item.paidKopecks);
    const rawDaysOverdue = remaining > 0 ? Math.max(0, item.daysOverdue) : 0;
    const isEffectivelyOverdue = remaining > 0 && rawDaysOverdue >= overdueThresholdDays;

    if (remaining > 0 && rawDaysOverdue > 0 && rawDaysOverdue < overdueThresholdDays) {
      inGracePeriodCount++;
      if (rawDaysOverdue > maxGraceDaysElapsed) {
        maxGraceDaysElapsed = rawDaysOverdue;
      }
    }

    if (isEffectivelyOverdue) {
      effectiveOverdueKopecks += remaining;
      if (rawDaysOverdue > maxEffectiveDaysOverdue) {
        maxEffectiveDaysOverdue = rawDaysOverdue;
      }
      currentStreak++;
      if (currentStreak > maxConsecutiveOverdueCount) {
        maxConsecutiveOverdueCount = currentStreak;
      }
    } else if (remaining === 0) {
      currentStreak = 0;
      if (item.lastPaidEventDate) {
        const lateDays = diffDaysBetweenIsoDates(item.dueDate, item.lastPaidEventDate);
        if (lateDays >= overdueThresholdDays) {
          pastLateCount++;
        }
      } else if (item.dueDate > item.originalDueDate) {
        pastLateCount++;
      }
    } else {
      // Future pending installment not yet due
      if (!nextPaymentDate || item.dueDate < nextPaymentDate) {
        nextPaymentDate = item.dueDate;
        nextPaymentAmountKopecks = remaining;
      }
    }

    // If an overdue or grace-period item is the earliest unpaid, also track it as nearest due if none set
    if (remaining > 0 && (!nextPaymentDate || item.dueDate < nextPaymentDate)) {
      nextPaymentDate = item.dueDate;
      nextPaymentAmountKopecks = remaining;
    }
  }

  if (contract.currentScheduleVersion > 1 || contract.status === 'restructured') {
    pastLateCount = Math.max(1, pastLateCount);
  }

  // Check for 'complex' thresholds
  if (
    effectiveOverdueKopecks > 0 &&
    (maxEffectiveDaysOverdue >= rules.complexMinOverdueDays ||
      maxConsecutiveOverdueCount >= rules.complexConsecutiveMissedCount ||
      effectiveOverdueKopecks >= rules.complexMinOverdueKopecks)
  ) {
    const reasons: string[] = [];
    if (maxEffectiveDaysOverdue >= rules.complexMinOverdueDays) {
      reasons.push(`длительная просрочка ${maxEffectiveDaysOverdue} дн. (порог: ${rules.complexMinOverdueDays} дн.)`);
    }
    if (maxConsecutiveOverdueCount >= rules.complexConsecutiveMissedCount) {
      reasons.push(
        `пропущено платежей подряд: ${maxConsecutiveOverdueCount} (порог: ${rules.complexConsecutiveMissedCount})`
      );
    }
    if (effectiveOverdueKopecks >= rules.complexMinOverdueKopecks) {
      reasons.push(
        `значительная просроченная задолженность ${formatKopecksShort(effectiveOverdueKopecks)} (порог: ${formatKopecksShort(rules.complexMinOverdueKopecks)})`
      );
    }
    return {
      status: 'complex',
      label: translateClientPaymentStatus('complex'),
      reason: `Договор ${contract.contractNumber}: ${reasons.join('; ')}.`,
      effectiveOverdueKopecks,
      maxEffectiveDaysOverdue,
      consecutiveOverdueCount: maxConsecutiveOverdueCount,
      pastLateCount,
      nextPaymentDate,
      nextPaymentAmountKopecks,
    };
  }

  // Check for 'watch' (active overdue after the 3-day payment window, below complex threshold)
  if (effectiveOverdueKopecks > 0) {
    return {
      status: 'watch',
      label: translateClientPaymentStatus('watch'),
      reason: `Договор ${contract.contractNumber}: платёж не внесён в течение ${graceDays > 0 ? `${graceDays} дн.` : 'установленного срока'} после даты оплаты — текущая просрочка ${formatKopecksShort(effectiveOverdueKopecks)} (${maxEffectiveDaysOverdue} дн.), требуется контроль оплаты.`,
      effectiveOverdueKopecks,
      maxEffectiveDaysOverdue,
      consecutiveOverdueCount: maxConsecutiveOverdueCount,
      pastLateCount,
      nextPaymentDate,
      nextPaymentAmountKopecks,
    };
  }

  // No current overdue beyond the 3-day grace window -> keep 'reliable' (if past late / restructured) or 'vip'
  if (pastLateCount > 0 || contract.status === 'restructured') {
    const graceSuffix =
      inGracePeriodCount > 0
        ? ` (текущий платёж ожидается в течение ${graceDays} дн. после даты оплаты, прошло ${maxGraceDaysElapsed} дн.)`
        : '';
    const details =
      contract.status === 'restructured' || contract.currentScheduleVersion > 1
        ? `график был перенесён/реструктурирован (v${contract.currentScheduleVersion}), текущий график соблюдается${graceSuffix}`
        : `ранее зафиксировано небольших задержек: ${pastLateCount}, сейчас просроченной задолженности нет${graceSuffix}`;
    return {
      status: 'reliable',
      label: translateClientPaymentStatus('reliable'),
      reason: `Договор ${contract.contractNumber}: ${details}.`,
      effectiveOverdueKopecks: 0,
      maxEffectiveDaysOverdue: 0,
      consecutiveOverdueCount: 0,
      pastLateCount,
      nextPaymentDate,
      nextPaymentAmountKopecks,
    };
  }

  return {
    status: 'vip',
    label: translateClientPaymentStatus('vip'),
    reason:
      inGracePeriodCount > 0
        ? `Договор ${contract.contractNumber}: наступил срок оплаты (ожидается платёж в течение ${graceDays} дн. после даты платежа, прошло ${maxGraceDaysElapsed} дн. — статус сохраняется).`
        : `Договор ${contract.contractNumber}: все платежи вносятся строго по графику, просрочек нет.`,
    effectiveOverdueKopecks: 0,
    maxEffectiveDaysOverdue: 0,
    consecutiveOverdueCount: 0,
    pastLateCount: 0,
    nextPaymentDate,
    nextPaymentAmountKopecks,
  };
}

/**
 * Evaluates a client's overall status across all of their contracts.
 * - If client has active contracts: reflects the most serious status among active contracts
 *   (also accounting for aggregated overdue debt across multiple active contracts).
 * - If client has no active contracts, but has completed contracts: returns 'closed' ("Рассрочка закрыта").
 * - If client has neither active nor completed contracts: returns 'new' ("Новый клиент").
 */
export function evaluateClientOverallStatus(
  contracts: ContractEvalInput[],
  rules: StatusRulesConfigDTO = DEFAULT_STATUS_RULES
): ComputedStatusResult & {
  activeContractsCount: number;
  completedContractsCount: number;
} {
  const activeContracts = contracts.filter(
    (c) => c.status === 'active' || c.status === 'restructured'
  );
  const completedContracts = contracts.filter((c) => c.status === 'completed');

  if (activeContracts.length === 0) {
    if (completedContracts.length > 0) {
      return {
        status: 'closed',
        label: translateClientPaymentStatus('closed'),
        reason: `Все договорные обязательства выполнены (закрыто договоров: ${completedContracts.length}, активных рассрочек нет).`,
        effectiveOverdueKopecks: 0,
        maxEffectiveDaysOverdue: 0,
        consecutiveOverdueCount: 0,
        pastLateCount: 0,
        nextPaymentDate: null,
        nextPaymentAmountKopecks: 0,
        activeContractsCount: 0,
        completedContractsCount: completedContracts.length,
      };
    }

    return {
      status: 'new',
      label: translateClientPaymentStatus('new'),
      reason: 'У клиента пока нет активных или завершённых договоров рассрочки.',
      effectiveOverdueKopecks: 0,
      maxEffectiveDaysOverdue: 0,
      consecutiveOverdueCount: 0,
      pastLateCount: 0,
      nextPaymentDate: null,
      nextPaymentAmountKopecks: 0,
      activeContractsCount: 0,
      completedContractsCount: 0,
    };
  }

  const activeEvaluations = activeContracts.map((c) => evaluateContractStatus(c, rules));
  const completedEvaluations = completedContracts.map((c) => evaluateContractStatus(c, rules));

  const totalEffectiveOverdueKopecks = activeEvaluations.reduce(
    (sum, e) => sum + e.effectiveOverdueKopecks,
    0
  );
  const maxEffectiveDaysOverdue = activeEvaluations.reduce(
    (max, e) => Math.max(max, e.maxEffectiveDaysOverdue),
    0
  );
  const maxConsecutiveOverdue = activeEvaluations.reduce(
    (max, e) => Math.max(max, e.consecutiveOverdueCount),
    0
  );
  const totalPastLateCount =
    activeEvaluations.reduce((sum, e) => sum + e.pastLateCount, 0) +
    completedEvaluations.reduce((sum, e) => sum + e.pastLateCount, 0);

  let nextPaymentDate: string | null = null;
  let nextPaymentAmountKopecks = 0;
  for (const ev of activeEvaluations) {
    if (ev.nextPaymentDate) {
      if (!nextPaymentDate || ev.nextPaymentDate < nextPaymentDate) {
        nextPaymentDate = ev.nextPaymentDate;
        nextPaymentAmountKopecks = ev.nextPaymentAmountKopecks;
      } else if (ev.nextPaymentDate === nextPaymentDate) {
        nextPaymentAmountKopecks += ev.nextPaymentAmountKopecks;
      }
    }
  }

  // Pick the most severe status across active contracts
  let worstEval = activeEvaluations[0];
  for (const ev of activeEvaluations) {
    if (PAYMENT_STATUS_SEVERITY[ev.status] > PAYMENT_STATUS_SEVERITY[worstEval.status]) {
      worstEval = ev;
    }
  }

  // Also check if combined overdue across multiple active contracts crosses complexMinOverdueKopecks
  if (
    worstEval.status === 'watch' &&
    totalEffectiveOverdueKopecks >= rules.complexMinOverdueKopecks
  ) {
    return {
      status: 'complex',
      label: translateClientPaymentStatus('complex'),
      reason: `Суммарная просроченная задолженность по активным договорам (${formatKopecksShort(totalEffectiveOverdueKopecks)}) превысила порог статуса «Сложный» (${formatKopecksShort(rules.complexMinOverdueKopecks)}).`,
      effectiveOverdueKopecks: totalEffectiveOverdueKopecks,
      maxEffectiveDaysOverdue,
      consecutiveOverdueCount: maxConsecutiveOverdue,
      pastLateCount: totalPastLateCount,
      nextPaymentDate,
      nextPaymentAmountKopecks,
      activeContractsCount: activeContracts.length,
      completedContractsCount: completedContracts.length,
    };
  }

  // If all active contracts are timely ('vip'), but a previous completed contract had past late payments, classify as 'reliable'
  if (worstEval.status === 'vip' && totalPastLateCount > 0) {
    return {
      status: 'reliable',
      label: translateClientPaymentStatus('reliable'),
      reason: `Текущие договоры (${activeContracts.length}) оплачиваются вовремя, но ранее допускались небольшие задержки (${totalPastLateCount}) без текущей задолженности.`,
      effectiveOverdueKopecks: 0,
      maxEffectiveDaysOverdue: 0,
      consecutiveOverdueCount: 0,
      pastLateCount: totalPastLateCount,
      nextPaymentDate,
      nextPaymentAmountKopecks,
      activeContractsCount: activeContracts.length,
      completedContractsCount: completedContracts.length,
    };
  }

  const summaryPrefix =
    activeContracts.length > 1
      ? `Активных договоров: ${activeContracts.length}${completedContracts.length > 0 ? ` (закрытых: ${completedContracts.length})` : ''}. `
      : completedContracts.length > 0
        ? `Активных договоров: 1 (закрытых: ${completedContracts.length}). `
        : '';

  return {
    status: worstEval.status,
    label: translateClientPaymentStatus(worstEval.status),
    reason: `${summaryPrefix}${worstEval.reason}`,
    effectiveOverdueKopecks: totalEffectiveOverdueKopecks,
    maxEffectiveDaysOverdue,
    consecutiveOverdueCount: maxConsecutiveOverdue,
    pastLateCount: totalPastLateCount,
    nextPaymentDate,
    nextPaymentAmountKopecks,
    activeContractsCount: activeContracts.length,
    completedContractsCount: completedContracts.length,
  };
}
