import { RoundingRule, ScheduleType } from '../../shared/types';

export interface ContractCalculationInput {
  purchaseCostKopecks: number;
  deliveryCostKopecks: number;
  otherCostKopecks: number;
  markupPercent: number;
  downPaymentPercent?: number;
  explicitDownPaymentKopecks?: number;
  termMonths: number;
  roundingRule: RoundingRule;
  scheduleType: ScheduleType;
  startDate: string; // YYYY-MM-DD
  customInstallmentsKopecks?: number[];
}

export interface PlannedScheduleItem {
  installmentNumber: number;
  dueDate: string;
  plannedKopecks: number;
}

export interface ContractCalculationResult {
  purchaseCostKopecks: number;
  deliveryCostKopecks: number;
  otherCostKopecks: number;
  totalCostKopecks: number;
  markupPercent: number;
  markupKopecks: number;
  salePriceKopecks: number;
  downPaymentPercent: number;
  downPaymentKopecks: number;
  financedPrincipalKopecks: number;
  termMonths: number;
  roundingRule: RoundingRule;
  scheduleType: ScheduleType;
  schedule: PlannedScheduleItem[];
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

export function addMonthsIsoDate(startDateIso: string, monthsToAdd: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDateIso.trim());
  if (!match) {
    throw new Error(`Некорректный формат даты: ${startDateIso}. Ожидается ГГГГ-ММ-ДД.`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);

  const targetMonthTotal = year * 12 + monthIndex + monthsToAdd;
  const targetYear = Math.floor(targetMonthTotal / 12);
  const targetMonth = targetMonthTotal % 12;

  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  const yyyy = String(targetYear).padStart(4, '0');
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

export function calculateContractAndSchedule(input: ContractCalculationInput): ContractCalculationResult {
  const totalCostKopecks = calculateTotalCostKopecks(
    input.purchaseCostKopecks,
    input.deliveryCostKopecks,
    input.otherCostKopecks
  );

  if (totalCostKopecks <= 0) {
    throw new Error('Полная себестоимость товара должна быть больше 0 копеек.');
  }

  if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0 || input.markupPercent > 500) {
    throw new Error('Процент наценки должен быть в диапазоне от 0% до 500%.');
  }

  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 120) {
    throw new Error('Срок рассрочки должен составлять от 1 до 120 месяцев.');
  }

  // Basis points (1% = 100 bp) for deterministic integer-safe percentage calculation
  const markupBasisPoints = Math.round(input.markupPercent * 100);
  const markupKopecks = Math.round((totalCostKopecks * markupBasisPoints) / 10000);
  const salePriceKopecks = totalCostKopecks + markupKopecks;

  let downPaymentKopecks: number;
  let effectiveDownPaymentPercent: number;

  if (typeof input.explicitDownPaymentKopecks === 'number') {
    assertKopecks(input.explicitDownPaymentKopecks, 'Первоначальный взнос', true);
    if (input.explicitDownPaymentKopecks >= salePriceKopecks) {
      throw new Error('Первоначальный взнос должен быть меньше полной цены продажи в рассрочку.');
    }
    downPaymentKopecks = input.explicitDownPaymentKopecks;
    effectiveDownPaymentPercent = Number(((downPaymentKopecks * 100) / salePriceKopecks).toFixed(2));
  } else {
    const dpPercent = input.downPaymentPercent ?? 30;
    if (!Number.isFinite(dpPercent) || dpPercent < 0 || dpPercent >= 100) {
      throw new Error('Процент первоначального взноса должен быть от 0% до 99,99%.');
    }
    const dpBasisPoints = Math.round(dpPercent * 100);
    downPaymentKopecks = Math.round((salePriceKopecks * dpBasisPoints) / 10000);
    effectiveDownPaymentPercent = dpPercent;
  }

  const financedPrincipalKopecks = salePriceKopecks - downPaymentKopecks;
  if (financedPrincipalKopecks <= 0) {
    throw new Error('Сумма остатка к погашению должна быть больше 0 копеек.');
  }

  const schedule: PlannedScheduleItem[] = [];

  if (input.scheduleType === 'custom') {
    if (!input.customInstallmentsKopecks || input.customInstallmentsKopecks.length !== input.termMonths) {
      throw new Error('Для индивидуального графика необходимо указать суммы всех платежей по числу месяцев.');
    }
    let sumCustom = 0;
    for (let i = 0; i < input.termMonths; i++) {
      const amount = input.customInstallmentsKopecks[i];
      assertKopecks(amount, `Платёж №${i + 1}`, false);
      sumCustom += amount;
      schedule.push({
        installmentNumber: i + 1,
        dueDate: addMonthsIsoDate(input.startDate, i + 1),
        plannedKopecks: amount,
      });
    }
    if (sumCustom !== financedPrincipalKopecks) {
      throw new Error(
        `Сумма индивидуального графика (${formatRubles(sumCustom)}) не совпадает с остатком по договору (${formatRubles(financedPrincipalKopecks)}).`
      );
    }
  } else {
    const rawMonthly = financedPrincipalKopecks / input.termMonths;
    let regularPayment = applyRoundingRuleToInstallment(rawMonthly, input.roundingRule);
    // Fallback to kopeck rounding if aggressive rounding makes regular payment 0 or exceeds principal
    if (regularPayment <= 0 || regularPayment * (input.termMonths - 1) >= financedPrincipalKopecks) {
      regularPayment = Math.floor(rawMonthly);
    }

    let accumulated = 0;
    for (let i = 0; i < input.termMonths; i++) {
      const isLast = i === input.termMonths - 1;
      const plannedKopecks = isLast ? financedPrincipalKopecks - accumulated : regularPayment;
      accumulated += plannedKopecks;
      schedule.push({
        installmentNumber: i + 1,
        dueDate: addMonthsIsoDate(input.startDate, i + 1),
        plannedKopecks,
      });
    }
  }

  return {
    purchaseCostKopecks: input.purchaseCostKopecks,
    deliveryCostKopecks: input.deliveryCostKopecks,
    otherCostKopecks: input.otherCostKopecks,
    totalCostKopecks,
    markupPercent: input.markupPercent,
    markupKopecks,
    salePriceKopecks,
    downPaymentPercent: effectiveDownPaymentPercent,
    downPaymentKopecks,
    financedPrincipalKopecks,
    termMonths: input.termMonths,
    roundingRule: input.roundingRule,
    scheduleType: input.scheduleType,
    schedule,
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
  strategy: AutoAllocationStrategy = 'spread_remaining'
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

