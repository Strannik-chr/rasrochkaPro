import type { DownPaymentMode, MarkupMode, RoundingRule, ScheduleType } from '../../shared/types.ts';

export interface ContractCalculationInput {
  purchaseCostKopecks: number;
  deliveryCostKopecks: number;
  otherCostKopecks: number;
  markupMode?: MarkupMode;
  markupPercent: number;
  explicitMarkupKopecks?: number;
  downPaymentMode?: DownPaymentMode;
  downPaymentPercent?: number;
  fixedDownPaymentKopecks?: number;
  explicitDownPaymentKopecks?: number;
  useCustomActualDownPayment?: boolean;
  actualDownPaymentKopecks?: number;
  allowExceedWarning?: boolean;
  termMonths: number;
  roundingRule: RoundingRule;
  scheduleType: ScheduleType;
  startDate: string; // YYYY-MM-DD
  scheduleStartDate?: string | null; // Optional YYYY-MM-DD anchor for schedule generation
  paymentDayOfMonth?: number | null; // 1..31
  customInstallmentsKopecks?: number[];
}

export interface PlannedScheduleItem {
  installmentNumber: number;
  dueDate: string;
  plannedKopecks: number;
  originalPlannedKopecks?: number;
  diffKopecks?: number;
}

export interface ContractCalculationResult {
  purchaseCostKopecks: number;
  deliveryCostKopecks: number;
  otherCostKopecks: number;
  totalCostKopecks: number;
  markupMode: MarkupMode;
  markupPercent: number;
  markupKopecks: number;
  salePriceKopecks: number;
  downPaymentMode: DownPaymentMode;
  downPaymentPercent: number;
  downPaymentKopecks: number;
  plannedDownPaymentKopecks: number;
  actualDownPaymentKopecks: number;
  downPaymentDiffKopecks: number;
  extraDownPaymentKopecks: number;
  downPaymentShortfallKopecks: number;
  useCustomActualDownPayment: boolean;
  plannedFinancedPrincipalKopecks: number;
  financedPrincipalKopecks: number;
  termMonths: number;
  roundingRule: RoundingRule;
  scheduleType: ScheduleType;
  paymentDayOfMonth: number;
  scheduleStartDate: string;
  schedule: PlannedScheduleItem[];
  plannedSchedule: PlannedScheduleItem[];
  scheduleChanged: boolean;
  exceedsTotalContractDebt: boolean;
  excessOverContractKopecks: number;
  warningMessage: string | null;
}

export interface EarlyPayoffOption {
  mode: 'full_balance' | 'proportional_markup_discount' | 'plan_discount' | 'manual_owner';
  title: string;
  description: string;
  remainingScheduleKopecks: number;
  discountKopecks: number;
  payoffAmountKopecks: number;
  retainedMarkupKopecks: number;
  requiresLegalConfirmation: boolean;
}

export function assertKopecks(value: number, fieldName: string, allowZero = true): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Поле «${fieldName}» должно быть целым числом копеек.`);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new Error(`Поле «${fieldName}» должно быть ${allowZero ? 'неотрицательным' : 'больше нуля'}.`);
  }
}

export function calculateTotalCostKopecks(
  purchasePriceKopecks: number,
  deliveryCostKopecks: number,
  otherCostKopecks = 0
): number {
  assertKopecks(purchasePriceKopecks, 'Цена покупки', true);
  assertKopecks(deliveryCostKopecks, 'Доставка', true);
  assertKopecks(otherCostKopecks, 'Прочие прямые расходы', true);
  return purchasePriceKopecks + deliveryCostKopecks + otherCostKopecks;
}

export function assertPaymentDayOfMonth(day: unknown): number {
  const num = typeof day === 'string' && day.trim() !== '' ? Number(day) : day;
  if (typeof num !== 'number' || !Number.isInteger(num) || num < 1 || num > 31) {
    throw new Error('Дата ежемесячного платежа должна быть целым числом от 1 до 31.');
  }
  return num;
}

export function addMonthsIsoDate(
  startDateIso: string,
  monthsToAdd: number,
  preferredDayOfMonth?: number | null
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDateIso.trim());
  if (!match) {
    throw new Error(`Некорректный формат даты: ${startDateIso}. Ожидается ГГГГ-ММ-ДД.`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const startDay = Number(match[3]);

  const desiredDay =
    preferredDayOfMonth !== undefined && preferredDayOfMonth !== null
      ? assertPaymentDayOfMonth(preferredDayOfMonth)
      : startDay;

  // Ensure the first installment is never in the past relative to startDateIso
  const effectiveMonthsToAdd = Math.max(1, monthsToAdd);
  const targetMonthTotal = year * 12 + monthIndex + effectiveMonthsToAdd;
  const targetYear = Math.floor(targetMonthTotal / 12);
  const targetMonth = targetMonthTotal % 12;

  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(desiredDay, daysInTargetMonth);

  const yyyy = String(targetYear).padStart(4, '0');
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  const resultDate = `${yyyy}-${mm}-${dd}`;
  if (resultDate <= startDateIso.trim()) {
    return addMonthsIsoDate(startDateIso, effectiveMonthsToAdd + 1, desiredDay);
  }
  return resultDate;
}

export interface ScheduleInstallmentForDateRecalc {
  id: string;
  installmentNumber: number;
  dueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  status: string;
}

/**
 * Recalculates due dates for future unpaid installments when the contract's
 * monthly payment day changes. Already paid installments remain completely untouched.
 */
export function recalculateUnpaidScheduleDates<T extends ScheduleInstallmentForDateRecalc>(
  items: T[],
  startDateIso: string,
  newPaymentDayOfMonth: number
): T[] {
  const validDay = assertPaymentDayOfMonth(newPaymentDayOfMonth);
  let lastAnchorDate = startDateIso.trim();

  return items.map((item, idx) => {
    const isPaid = item.status === 'paid' || (item.plannedKopecks > 0 && item.paidKopecks >= item.plannedKopecks);
    if (isPaid) {
      if (item.dueDate > lastAnchorDate) {
        lastAnchorDate = item.dueDate;
      }
      return { ...item };
    }

    const monthOffset = item.installmentNumber > 0 ? item.installmentNumber : idx + 1;
    let candidateDate = addMonthsIsoDate(startDateIso, monthOffset, validDay);
    let extraMonths = 1;
    while (candidateDate <= lastAnchorDate && extraMonths <= 240) {
      candidateDate = addMonthsIsoDate(startDateIso, monthOffset + extraMonths, validDay);
      extraMonths++;
    }
    lastAnchorDate = candidateDate;
    return {
      ...item,
      dueDate: candidateDate,
    };
  });
}

export function applyRoundingRuleToInstallment(rawKopecks: number, rule: RoundingRule): number {
  switch (rule) {
    case 'kopeck':
      return Math.floor(rawKopecks);
    case 'ruble':
      return Math.floor(rawKopecks / 100) * 100;
    case 'ten_rubles':
      return Math.floor(rawKopecks / 1000) * 1000;
    default:
      return Math.floor(rawKopecks);
  }
}

function generateEqualInstallmentSchedule(
  principalKopecks: number,
  termMonths: number,
  roundingRule: RoundingRule,
  startDate: string,
  paymentDayOfMonth?: number | null
): PlannedScheduleItem[] {
  if (principalKopecks <= 0) {
    return [];
  }
  const rawMonthly = principalKopecks / termMonths;
  let regularPayment = applyRoundingRuleToInstallment(rawMonthly, roundingRule);
  // Fallback to kopeck rounding if aggressive rounding makes regular payment 0 or exceeds principal
  if (regularPayment <= 0 || regularPayment * (termMonths - 1) >= principalKopecks) {
    regularPayment = Math.floor(rawMonthly);
  }

  const items: PlannedScheduleItem[] = [];
  let accumulated = 0;
  for (let i = 0; i < termMonths; i++) {
    const isLast = i === termMonths - 1;
    const plannedKopecks = isLast ? principalKopecks - accumulated : regularPayment;
    accumulated += plannedKopecks;
    items.push({
      installmentNumber: i + 1,
      dueDate: addMonthsIsoDate(startDate, i + 1, paymentDayOfMonth),
      plannedKopecks,
    });
  }
  return items;
}

export function calculateContractAndSchedule(input: ContractCalculationInput): ContractCalculationResult {
  const totalCostKopecks = calculateTotalCostKopecks(
    input.purchaseCostKopecks,
    input.deliveryCostKopecks,
    input.otherCostKopecks
  );

  if (totalCostKopecks <= 0) {
    throw new Error('Полная себестоимость товара должна быть больше 0 копеек.');
  }

  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 120) {
    throw new Error('Срок рассрочки должен составлять от 1 до 120 месяцев.');
  }

  const resolvedMarkupMode: MarkupMode =
    input.markupMode === 'fixed' || (input.markupMode === undefined && typeof input.explicitMarkupKopecks === 'number')
      ? 'fixed'
      : 'percent';

  let markupKopecks: number;
  let effectiveMarkupPercent: number;

  if (resolvedMarkupMode === 'fixed' && typeof input.explicitMarkupKopecks === 'number') {
    assertKopecks(input.explicitMarkupKopecks, 'Сумма наценки', true);
    markupKopecks = input.explicitMarkupKopecks;
    effectiveMarkupPercent = Number(((markupKopecks * 100) / totalCostKopecks).toFixed(2));
    if (effectiveMarkupPercent > 500) {
      throw new Error('Сумма наценки превышает максимально допустимые 500% от себестоимости.');
    }
  } else {
    if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0 || input.markupPercent > 500) {
      throw new Error('Процент наценки должен быть в диапазоне от 0% до 500%.');
    }
    // Basis points (1% = 100 bp) for deterministic integer-safe percentage calculation
    const markupBasisPoints = Math.round(input.markupPercent * 100);
    markupKopecks = Math.round((totalCostKopecks * markupBasisPoints) / 10000);
    effectiveMarkupPercent = input.markupPercent;
  }

  const salePriceKopecks = totalCostKopecks + markupKopecks;

  const resolvedDownPaymentMode: DownPaymentMode =
    input.downPaymentMode === 'fixed' ||
    typeof input.fixedDownPaymentKopecks === 'number' ||
    (input.downPaymentMode === undefined &&
      typeof input.explicitDownPaymentKopecks === 'number' &&
      !input.useCustomActualDownPayment)
      ? 'fixed'
      : 'percent';

  let plannedDownPaymentKopecks: number;
  let effectiveDownPaymentPercent: number;

  const fixedDpCandidate =
    typeof input.fixedDownPaymentKopecks === 'number'
      ? input.fixedDownPaymentKopecks
      : resolvedDownPaymentMode === 'fixed' && typeof input.explicitDownPaymentKopecks === 'number'
        ? input.explicitDownPaymentKopecks
        : undefined;

  if (resolvedDownPaymentMode === 'fixed' && typeof fixedDpCandidate === 'number') {
    assertKopecks(fixedDpCandidate, 'Первоначальный взнос', true);
    if (fixedDpCandidate >= salePriceKopecks) {
      throw new Error('Первоначальный взнос должен быть меньше полной цены продажи в рассрочку.');
    }
    plannedDownPaymentKopecks = fixedDpCandidate;
    effectiveDownPaymentPercent = Number(((plannedDownPaymentKopecks * 100) / salePriceKopecks).toFixed(2));
  } else {
    const dpPercent = input.downPaymentPercent ?? 30;
    if (!Number.isFinite(dpPercent) || dpPercent < 0 || dpPercent >= 100) {
      throw new Error('Процент первоначального взноса должен быть от 0% до 99,99%.');
    }
    const dpBasisPoints = Math.round(dpPercent * 100);
    plannedDownPaymentKopecks = Math.round((salePriceKopecks * dpBasisPoints) / 10000);
    effectiveDownPaymentPercent = dpPercent;
  }

  const plannedFinancedPrincipalKopecks = salePriceKopecks - plannedDownPaymentKopecks;
  if (plannedFinancedPrincipalKopecks <= 0) {
    throw new Error('Сумма планового остатка к погашению должна быть больше 0 копеек.');
  }

  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.startDate.trim());
  if (!startMatch) {
    throw new Error(`Некорректный формат даты: ${input.startDate}. Ожидается ГГГГ-ММ-ДД.`);
  }
  const effectiveScheduleStartDate =
    input.scheduleStartDate && input.scheduleStartDate.trim() !== ''
      ? input.scheduleStartDate.trim()
      : input.startDate.trim();
  const schedStartMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveScheduleStartDate);
  if (!schedStartMatch) {
    throw new Error(`Некорректный формат даты начала графика: ${effectiveScheduleStartDate}. Ожидается ГГГГ-ММ-ДД.`);
  }

  const resolvedPaymentDayOfMonth =
    input.paymentDayOfMonth !== undefined && input.paymentDayOfMonth !== null
      ? assertPaymentDayOfMonth(input.paymentDayOfMonth)
      : assertPaymentDayOfMonth(Number(schedStartMatch[3]));

  const plannedSchedule = generateEqualInstallmentSchedule(
    plannedFinancedPrincipalKopecks,
    input.termMonths,
    input.roundingRule,
    effectiveScheduleStartDate,
    resolvedPaymentDayOfMonth
  );

  const useCustom = Boolean(input.useCustomActualDownPayment);
  let actualDownPaymentKopecks = plannedDownPaymentKopecks;

  if (useCustom) {
    const rawActual =
      typeof input.actualDownPaymentKopecks === 'number'
        ? input.actualDownPaymentKopecks
        : typeof input.explicitDownPaymentKopecks === 'number'
          ? input.explicitDownPaymentKopecks
          : plannedDownPaymentKopecks;
    assertKopecks(rawActual, 'Фактически внесено', true);
    actualDownPaymentKopecks = rawActual;
  }

  const downPaymentDiffKopecks = actualDownPaymentKopecks - plannedDownPaymentKopecks;
  const downPaymentShortfallKopecks = Math.max(0, plannedDownPaymentKopecks - actualDownPaymentKopecks);
  const extraDownPaymentKopecks = Math.max(0, actualDownPaymentKopecks - plannedDownPaymentKopecks);

  if (useCustom && actualDownPaymentKopecks >= salePriceKopecks) {
    const excessOverContractKopecks = Math.max(0, actualDownPaymentKopecks - salePriceKopecks);
    const warningMessage =
      actualDownPaymentKopecks > salePriceKopecks
        ? `Внесённая сумма (${formatRubles(actualDownPaymentKopecks)}) превышает общий долг по договору (${formatRubles(salePriceKopecks)}) на ${formatRubles(excessOverContractKopecks)}. Лишние деньги не распределяются автоматически на другие договоры.`
        : `Внесённая сумма (${formatRubles(actualDownPaymentKopecks)}) равна полной стоимости договора (${formatRubles(salePriceKopecks)}). Остаток долга для графика рассрочки равен 0 ₽.`;

    if (!input.allowExceedWarning) {
      throw new Error(warningMessage);
    }

    return {
      purchaseCostKopecks: input.purchaseCostKopecks,
      deliveryCostKopecks: input.deliveryCostKopecks,
      otherCostKopecks: input.otherCostKopecks,
      totalCostKopecks,
      markupMode: resolvedMarkupMode,
      markupPercent: effectiveMarkupPercent,
      markupKopecks,
      salePriceKopecks,
      downPaymentMode: resolvedDownPaymentMode,
      downPaymentPercent: effectiveDownPaymentPercent,
      downPaymentKopecks: actualDownPaymentKopecks,
      plannedDownPaymentKopecks,
      actualDownPaymentKopecks,
      downPaymentDiffKopecks,
      extraDownPaymentKopecks,
      downPaymentShortfallKopecks,
      useCustomActualDownPayment: true,
      plannedFinancedPrincipalKopecks,
      financedPrincipalKopecks: 0,
      termMonths: input.termMonths,
      roundingRule: input.roundingRule,
      scheduleType: input.scheduleType,
      paymentDayOfMonth: resolvedPaymentDayOfMonth,
      scheduleStartDate: effectiveScheduleStartDate,
      schedule: [],
      plannedSchedule,
      scheduleChanged: true,
      exceedsTotalContractDebt: true,
      excessOverContractKopecks,
      warningMessage,
    };
  }

  const downPaymentKopecks = useCustom ? actualDownPaymentKopecks : plannedDownPaymentKopecks;
  const financedPrincipalKopecks = salePriceKopecks - downPaymentKopecks;
  if (financedPrincipalKopecks <= 0) {
    throw new Error('Сумма остатка к погашению должна быть больше 0 копеек.');
  }

  let schedule: PlannedScheduleItem[] = [];

  if (input.scheduleType === 'custom') {
    if (!input.customInstallmentsKopecks || input.customInstallmentsKopecks.length !== input.termMonths) {
      throw new Error('Для индивидуального графика необходимо указать суммы всех платежей по числу месяцев.');
    }
    let sumCustom = 0;
    for (let i = 0; i < input.termMonths; i++) {
      const amount = input.customInstallmentsKopecks[i];
      assertKopecks(amount, `Платёж №${i + 1}`, false);
      sumCustom += amount;
      const origPlanned = plannedSchedule[i]?.plannedKopecks ?? amount;
      schedule.push({
        installmentNumber: i + 1,
        dueDate: addMonthsIsoDate(effectiveScheduleStartDate, i + 1, resolvedPaymentDayOfMonth),
        plannedKopecks: amount,
        originalPlannedKopecks: origPlanned,
        diffKopecks: amount - origPlanned,
      });
    }
    if (sumCustom !== financedPrincipalKopecks) {
      throw new Error(
        `Сумма индивидуального графика (${formatRubles(sumCustom)}) не совпадает с остатком по договору (${formatRubles(financedPrincipalKopecks)}).`
      );
    }
  } else {
    const rawSchedule = generateEqualInstallmentSchedule(
      financedPrincipalKopecks,
      input.termMonths,
      input.roundingRule,
      effectiveScheduleStartDate,
      resolvedPaymentDayOfMonth
    );
    schedule = rawSchedule.map((item, idx) => {
      const origPlanned = plannedSchedule[idx]?.plannedKopecks ?? item.plannedKopecks;
      return {
        ...item,
        originalPlannedKopecks: origPlanned,
        diffKopecks: item.plannedKopecks - origPlanned,
      };
    });
  }

  const scheduleChanged = useCustom && actualDownPaymentKopecks !== plannedDownPaymentKopecks;

  return {
    purchaseCostKopecks: input.purchaseCostKopecks,
    deliveryCostKopecks: input.deliveryCostKopecks,
    otherCostKopecks: input.otherCostKopecks,
    totalCostKopecks,
    markupMode: resolvedMarkupMode,
    markupPercent: effectiveMarkupPercent,
    markupKopecks,
    salePriceKopecks,
    downPaymentMode: resolvedDownPaymentMode,
    downPaymentPercent: effectiveDownPaymentPercent,
    downPaymentKopecks,
    plannedDownPaymentKopecks,
    actualDownPaymentKopecks,
    downPaymentDiffKopecks,
    extraDownPaymentKopecks,
    downPaymentShortfallKopecks,
    useCustomActualDownPayment: useCustom,
    plannedFinancedPrincipalKopecks,
    financedPrincipalKopecks,
    termMonths: input.termMonths,
    roundingRule: input.roundingRule,
    scheduleType: input.scheduleType,
    paymentDayOfMonth: resolvedPaymentDayOfMonth,
    scheduleStartDate: effectiveScheduleStartDate,
    schedule,
    plannedSchedule,
    scheduleChanged,
    exceedsTotalContractDebt: false,
    excessOverContractKopecks: 0,
    warningMessage: null,
  };
}

export interface ExistingScheduleItemForEdit {
  id: string;
  installmentNumber: number;
  dueDate: string;
  originalDueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  status: string;
  promisedDate?: string | null;
  postponeReason?: string;
}

export interface EditedScheduleItemResult {
  installmentNumber: number;
  dueDate: string;
  originalDueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  remainingKopecks: number;
  status: 'paid' | 'partial' | 'pending';
  promisedDate: string | null;
  postponeReason: string;
  preservedFromItemId: string | null;
}

export interface ContractEditScheduleResult {
  calc: ContractCalculationResult;
  items: EditedScheduleItemResult[];
  totalPaidOnScheduleKopecks: number;
  remainingDebtKopecks: number;
  fullyPaidInstallmentsCount: number;
  partiallyPaidInstallmentsCount: number;
  unpaidInstallmentsCount: number;
  hasExistingPaymentsWarning: boolean;
  paymentPreservationSummary: string | null;
}

/**
 * Safely recalculates a contract's payment schedule during full contract editing,
 * preserving already-paid and partially-paid installments and redistributing
 * only the remaining unpaid balance across non-closed installments.
 */
export function recalculateContractEditSchedule(
  input: ContractCalculationInput,
  existingItems: ExistingScheduleItemForEdit[]
): ContractEditScheduleResult {
  const calc = calculateContractAndSchedule(input);

  const sortedExisting = [...existingItems].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const totalPaidOnScheduleKopecks = sortedExisting.reduce(
    (sum, it) => sum + Math.max(0, Math.trunc(it.paidKopecks || 0)),
    0
  );

  const itemsWithPayments = sortedExisting.filter((it) => (it.paidKopecks || 0) > 0);
  const fullyPaidItems = itemsWithPayments.filter((it) => it.paidKopecks >= it.plannedKopecks && it.plannedKopecks > 0);
  const partiallyPaidItems = itemsWithPayments.filter((it) => it.paidKopecks > 0 && it.paidKopecks < it.plannedKopecks);

  if (calc.financedPrincipalKopecks < totalPaidOnScheduleKopecks) {
    throw new Error(
      `Новый остаток по договору к рассрочке (${formatRubles(calc.financedPrincipalKopecks)}) меньше суммы, уже оплаченной клиентом по графику (${formatRubles(totalPaidOnScheduleKopecks)}). Увеличьте стоимость товара/наценку, уменьшите первоначальный взнос или сначала сторнируйте лишний платёж.`
    );
  }

  const remainingDebtKopecks = calc.financedPrincipalKopecks - totalPaidOnScheduleKopecks;
  const touchedCount = itemsWithPayments.length;

  if (calc.termMonths < touchedCount) {
    throw new Error(
      `Новый срок рассрочки (${calc.termMonths} мес.) меньше количества платежей, по которым уже внесены оплаты (${touchedCount} мес.). Укажите срок не менее ${touchedCount} мес.`
    );
  }

  if (remainingDebtKopecks > 0 && calc.termMonths <= fullyPaidItems.length) {
    throw new Error(
      `По договору уже полностью оплачено ${fullyPaidItems.length} мес., при этом остаётся непогашенный долг (${formatRubles(remainingDebtKopecks)}). Увеличьте срок рассрочки минимум до ${fullyPaidItems.length + 1} мес.`
    );
  }

  // Case 1: No schedule payments have been made yet -> use fresh schedule from calc
  if (totalPaidOnScheduleKopecks === 0) {
    const items: EditedScheduleItemResult[] = calc.schedule.map((s) => ({
      installmentNumber: s.installmentNumber,
      dueDate: s.dueDate,
      originalDueDate: s.dueDate,
      plannedKopecks: s.plannedKopecks,
      paidKopecks: 0,
      remainingKopecks: s.plannedKopecks,
      status: 'pending',
      promisedDate: null,
      postponeReason: '',
      preservedFromItemId: null,
    }));

    return {
      calc,
      items,
      totalPaidOnScheduleKopecks: 0,
      remainingDebtKopecks: calc.financedPrincipalKopecks,
      fullyPaidInstallmentsCount: 0,
      partiallyPaidInstallmentsCount: 0,
      unpaidInstallmentsCount: items.length,
      hasExistingPaymentsWarning: false,
      paymentPreservationSummary: null,
    };
  }

  // Case 2: Contract already has schedule payments -> preserve paid items and redistribute remainingDebtKopecks
  const openSlotsCount = calc.termMonths - fullyPaidItems.length;
  const shares: number[] = [];

  if (openSlotsCount > 0 && remainingDebtKopecks > 0) {
    const rawMonthly = remainingDebtKopecks / openSlotsCount;
    let regularShare = applyRoundingRuleToInstallment(rawMonthly, calc.roundingRule);
    if (regularShare <= 0 || regularShare * (openSlotsCount - 1) >= remainingDebtKopecks) {
      regularShare = Math.floor(rawMonthly);
    }
    let accumulated = 0;
    for (let i = 0; i < openSlotsCount; i++) {
      const isLast = i === openSlotsCount - 1;
      const share = isLast ? remainingDebtKopecks - accumulated : regularShare;
      accumulated += share;
      shares.push(share);
    }
  } else {
    for (let i = 0; i < openSlotsCount; i++) {
      shares.push(0);
    }
  }

  const finalItems: EditedScheduleItemResult[] = [];
  let lastAnchorDate = calc.scheduleStartDate;

  // 1. Add all fully paid installments first, preserving their exact paid amounts and due dates
  for (let i = 0; i < fullyPaidItems.length; i++) {
    const fp = fullyPaidItems[i];
    if (fp.dueDate > lastAnchorDate) {
      lastAnchorDate = fp.dueDate;
    }
    finalItems.push({
      installmentNumber: finalItems.length + 1,
      dueDate: fp.dueDate,
      originalDueDate: fp.originalDueDate || fp.dueDate,
      plannedKopecks: fp.paidKopecks,
      paidKopecks: fp.paidKopecks,
      remainingKopecks: 0,
      status: 'paid',
      promisedDate: fp.promisedDate || null,
      postponeReason: fp.postponeReason || '',
      preservedFromItemId: fp.id,
    });
  }

  // 2. Fill the remaining open slots (partially paid items first, then new unpaid items)
  for (let slotIdx = 0; slotIdx < openSlotsCount; slotIdx++) {
    const instNum = finalItems.length + 1;
    const unpaidShare = shares[slotIdx] || 0;
    const partialItem = partiallyPaidItems[slotIdx];

    let candidateDate = addMonthsIsoDate(calc.scheduleStartDate, instNum, calc.paymentDayOfMonth);
    let extraMonths = 1;
    while (candidateDate <= lastAnchorDate && extraMonths <= 240) {
      candidateDate = addMonthsIsoDate(calc.scheduleStartDate, instNum + extraMonths, calc.paymentDayOfMonth);
      extraMonths++;
    }
    lastAnchorDate = candidateDate;

    if (partialItem) {
      const planned = partialItem.paidKopecks + unpaidShare;
      const remaining = unpaidShare;
      finalItems.push({
        installmentNumber: instNum,
        dueDate: candidateDate,
        originalDueDate: partialItem.originalDueDate || candidateDate,
        plannedKopecks: planned,
        paidKopecks: partialItem.paidKopecks,
        remainingKopecks: remaining,
        status: remaining === 0 ? 'paid' : 'partial',
        promisedDate: partialItem.promisedDate || null,
        postponeReason: partialItem.postponeReason || '',
        preservedFromItemId: partialItem.id,
      });
    } else if (unpaidShare > 0) {
      finalItems.push({
        installmentNumber: instNum,
        dueDate: candidateDate,
        originalDueDate: candidateDate,
        plannedKopecks: unpaidShare,
        paidKopecks: 0,
        remainingKopecks: unpaidShare,
        status: 'pending',
        promisedDate: null,
        postponeReason: '',
        preservedFromItemId: null,
      });
    }
  }

  const paymentPreservationSummary =
    `По графику уже внесено ${formatRubles(totalPaidOnScheduleKopecks)} ` +
    `(закрыто месяцев: ${fullyPaidItems.length}${partiallyPaidItems.length > 0 ? `, частично оплачено: ${partiallyPaidItems.length}` : ''}). ` +
    `Оставшийся долг ${formatRubles(remainingDebtKopecks)} распределён на ${openSlotsCount} мес.`;

  return {
    calc,
    items: finalItems,
    totalPaidOnScheduleKopecks,
    remainingDebtKopecks,
    fullyPaidInstallmentsCount: fullyPaidItems.length,
    partiallyPaidInstallmentsCount: partiallyPaidItems.length,
    unpaidInstallmentsCount: openSlotsCount,
    hasExistingPaymentsWarning: true,
    paymentPreservationSummary,
  };
}

export function calculateEarlyPayoffComparison(params: {
  totalCostKopecks: number;
  salePriceKopecks: number;
  downPaymentKopecks: number;
  termMonths: number;
  remainingScheduleKopecks: number;
  unpaidInstallmentsCount: number;
  planDiscountPercent: number;
  manualPayoffKopecks?: number;
}): EarlyPayoffOption[] {
  const {
    totalCostKopecks,
    salePriceKopecks,
    termMonths,
    remainingScheduleKopecks,
    unpaidInstallmentsCount,
    planDiscountPercent,
    manualPayoffKopecks,
  } = params;

  const totalMarkupKopecks = Math.max(0, salePriceKopecks - totalCostKopecks);
  const alreadyPaidTotalKopecks = Math.max(0, salePriceKopecks - remainingScheduleKopecks);

  // 1. Без скидки (полный остаток по действующему графику)
  const fullBalanceOption: EarlyPayoffOption = {
    mode: 'full_balance',
    title: '1. Полный остаток по действующему графику (без скидки)',
    description: 'Погашение всей оставшейся суммы по графику без пересчёта наценки.',
    remainingScheduleKopecks,
    discountKopecks: 0,
    payoffAmountKopecks: remainingScheduleKopecks,
    retainedMarkupKopecks: totalMarkupKopecks,
    requiresLegalConfirmation: false,
  };

  // 2. Пропорциональный пересчёт будущей наценки за неиспользованные полные периоды
  const futureMonthsRatio = termMonths > 0 ? Math.max(0, Math.min(1, (unpaidInstallmentsCount - 1) / termMonths)) : 0;
  const proportionalDiscount = Math.min(
    remainingScheduleKopecks,
    Math.max(0, Math.round(totalMarkupKopecks * futureMonthsRatio * 0.5))
  );
  const proportionalPayoff = Math.max(0, remainingScheduleKopecks - proportionalDiscount);

  const proportionalOption: EarlyPayoffOption = {
    mode: 'proportional_markup_discount',
    title: '2. Скидка на будущую наценку (пропорционально оставшимся месяцам)',
    description: 'Предварительная модель: снижение наценки за досрочно закрываемые будущие периоды.',
    remainingScheduleKopecks,
    discountKopecks: proportionalDiscount,
    payoffAmountKopecks: proportionalPayoff,
    retainedMarkupKopecks: Math.max(0, alreadyPaidTotalKopecks + proportionalPayoff - totalCostKopecks),
    requiresLegalConfirmation: true,
  };

  // 3. Настраиваемая формула по тарифу (скидка % от оставшейся доли наценки)
  const effectivePlanDiscountPct = Math.max(0, Math.min(100, planDiscountPercent));
  const unearnedMarkupShare = termMonths > 0 ? Math.round((totalMarkupKopecks * unpaidInstallmentsCount) / termMonths) : 0;
  const planDiscountKopecks = Math.min(
    remainingScheduleKopecks,
    Math.round((unearnedMarkupShare * Math.round(effectivePlanDiscountPct * 100)) / 10000)
  );
  const planPayoff = Math.max(0, remainingScheduleKopecks - planDiscountKopecks);

  const planOption: EarlyPayoffOption = {
    mode: 'plan_discount',
    title: `3. По тарифной настройке (${effectivePlanDiscountPct}% от будущей наценки)`,
    description: 'Формула на основе параметра «Скидка при досрочном погашении» в настройках рассрочки.',
    remainingScheduleKopecks,
    discountKopecks: planDiscountKopecks,
    payoffAmountKopecks: planPayoff,
    retainedMarkupKopecks: Math.max(0, alreadyPaidTotalKopecks + planPayoff - totalCostKopecks),
    requiresLegalConfirmation: true,
  };

  // 4. Ручное утверждение суммы закрытия владельцем
  const manualTarget =
    typeof manualPayoffKopecks === 'number' && manualPayoffKopecks >= 0 && manualPayoffKopecks <= remainingScheduleKopecks
      ? manualPayoffKopecks
      : remainingScheduleKopecks;
  const manualDiscount = Math.max(0, remainingScheduleKopecks - manualTarget);

  const manualOption: EarlyPayoffOption = {
    mode: 'manual_owner',
    title: '4. Ручное утверждение суммы закрытия владельцем',
    description: 'Индивидуальная сумма закрытия договора по соглашению сторон.',
    remainingScheduleKopecks,
    discountKopecks: manualDiscount,
    payoffAmountKopecks: manualTarget,
    retainedMarkupKopecks: Math.max(0, alreadyPaidTotalKopecks + manualTarget - totalCostKopecks),
    requiresLegalConfirmation: true,
  };

  return [fullBalanceOption, proportionalOption, planOption, manualOption];
}

export function calculateDaysOverdue(dueDateIso: string, referenceDateIso: string): number {
  if (dueDateIso >= referenceDateIso) {
    return 0;
  }
  const dueMs = Date.parse(`${dueDateIso}T00:00:00Z`);
  const refMs = Date.parse(`${referenceDateIso}T00:00:00Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(refMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((refMs - dueMs) / (1000 * 60 * 60 * 24)));
}

export function formatRubles(kopecks: number): string {
  const sign = kopecks < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(kopecks));
  const rubles = Math.floor(abs / 100);
  const kop = abs % 100;
  const formattedRubles = rubles.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${formattedRubles},${String(kop).padStart(2, '0')} ₽`;
}

export function sanitizeSpreadsheetCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const str = String(raw);
  // Protect Excel / LibreOffice / Google Sheets from CSV formula injection
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function toSafeCsvRow(cells: Array<string | number | null | undefined>): string {
  return cells
    .map((cell) => {
      const safe = sanitizeSpreadsheetCell(cell).replace(/"/g, '""');
      return `"${safe}"`;
    })
    .join(';');
}

export type AutoAllocationStrategy = 'spread_remaining' | 'sequential';

export interface UnpaidScheduleItemInput {
  id: string;
  remainingKopecks: number;
}

export interface ComputedScheduleAllocation {
  scheduleItemId: string;
  amountKopecks: number;
}

/**
 * Computes automatic payment allocation across unpaid schedule items.
 *
 * Strategies:
 * - 'spread_remaining' (DEFAULT): Closes the current (first unpaid) month first, and distributes
 *   any remaining overpayment evenly across all remaining unpaid months.
 *   Example: Monthly payment is 15 000 ₽ (4 months left), client pays 18 000 ₽:
 *   Month 1 gets 15 000 ₽ (closed), and the remaining 3 000 ₽ is spread evenly across Months 2, 3, 4 (1 000 ₽ each).
 * - 'sequential': Closes unpaid months strictly one after another in chronological order.
 *   Example: Monthly payment is 7 000 ₽, client pays 15 000 ₽:
 *   Month 1 gets 7 000 ₽, Month 2 gets 7 000 ₽, Month 3 gets 1 000 ₽.
 */
export function computeAutomaticScheduleAllocations(
  totalKopecks: number,
  items: UnpaidScheduleItemInput[],
  strategy: AutoAllocationStrategy = 'sequential'
): ComputedScheduleAllocation[] {
  const validItems = items.filter((it) => it && it.remainingKopecks > 0);
  if (totalKopecks <= 0 || validItems.length === 0) {
    return [];
  }

  if (strategy === 'sequential') {
    const result: ComputedScheduleAllocation[] = [];
    let remaining = Math.max(0, Math.trunc(totalKopecks));
    for (const item of validItems) {
      if (remaining <= 0) break;
      const alloc = Math.min(item.remainingKopecks, remaining);
      if (alloc > 0) {
        result.push({
          scheduleItemId: item.id,
          amountKopecks: alloc,
        });
        remaining -= alloc;
      }
    }
    return result;
  }

  // Default strategy: 'spread_remaining'
  // 1. Close the current unpaid installment first
  const firstItem = validItems[0];
  const firstAlloc = Math.min(firstItem.remainingKopecks, Math.max(0, Math.trunc(totalKopecks)));
  const allocById: Record<string, number> = {
    [firstItem.id]: firstAlloc,
  };

  const restItems = validItems.slice(1);
  for (const it of restItems) {
    allocById[it.id] = 0;
  }

  let remainingToSpread = Math.max(0, Math.trunc(totalKopecks) - firstAlloc);

  // 2. Spread any extra overpayment evenly across all remaining unpaid months
  while (remainingToSpread > 0 && restItems.length > 0) {
    const active = restItems.filter((it) => it.remainingKopecks - allocById[it.id] > 0);
    if (active.length === 0) break;

    const count = active.length;
    const baseShare = Math.floor(remainingToSpread / count);
    const rem = remainingToSpread % count;

    let anyCapped = false;
    for (let i = 0; i < count; i++) {
      const targetAdd = baseShare + (i < rem ? 1 : 0);
      const capLeft = active[i].remainingKopecks - allocById[active[i].id];
      if (capLeft < targetAdd) {
        anyCapped = true;
        break;
      }
    }

    if (!anyCapped) {
      for (let i = 0; i < count; i++) {
        const targetAdd = baseShare + (i < rem ? 1 : 0);
        allocById[active[i].id] += targetAdd;
        remainingToSpread -= targetAdd;
      }
      break;
    } else {
      const minCapLeft = Math.min(...active.map((it) => it.remainingKopecks - allocById[it.id]));
      const stepShare = Math.max(1, Math.min(baseShare, minCapLeft));
      for (const it of active) {
        if (remainingToSpread <= 0) break;
        const capLeft = it.remainingKopecks - allocById[it.id];
        const add = Math.min(capLeft, stepShare, remainingToSpread);
        allocById[it.id] += add;
        remainingToSpread -= add;
      }
    }
  }

  const finalAllocations: ComputedScheduleAllocation[] = [];
  for (const item of validItems) {
    const amt = allocById[item.id] || 0;
    if (amt > 0) {
      finalAllocations.push({
        scheduleItemId: item.id,
        amountKopecks: amt,
      });
    }
  }
  return finalAllocations;
}

