import { ClientDTO, ContractDTO, InstallmentPlanDTO, RoundingRule } from './types.ts';

export interface NameParts {
  lastName: string;
  firstName: string;
  patronymic: string;
}

export function splitFullNameParts(fullName: string): NameParts {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    patronymic: parts.slice(2).join(' ') || '',
  };
}

export function joinFullNameParts(lastName: string, firstName: string, patronymic: string): string {
  return [lastName.trim(), firstName.trim(), patronymic.trim()].filter(Boolean).join(' ');
}

export interface ContractClientDraftState<TGuarantor = unknown> {
  clientMode: 'existing' | 'new';
  clientId: string;
  clientNameQuery: string;
  payerLastName: string;
  payerFirstName: string;
  payerPatronymic: string;
  newClientPhone: string;
  newClientSecondaryPhone: string;
  newClientDocumentRef: string;
  newClientAddress: string;
  newClientNotes: string;
  allowSimilarName: boolean;
  showSuggestions: boolean;
  guarantors: TGuarantor[];
}

export interface ContractTermsDraftState {
  purchaseRubles?: string;
  deliveryRubles?: string;
  otherRubles?: string;
  planId: string;
  termMonths: string;
  markupMode?: 'percent' | 'fixed';
  markupPercent: string;
  markupRubles?: string;
  downPaymentMode?: 'percent' | 'fixed';
  downPaymentPercent: string;
  downPaymentRubles?: string;
  paymentDayOfMonth: string;
  roundingRule: RoundingRule;
  useCustomActualDownPayment: boolean;
  actualDownPaymentRubles: string;
}

/**
 * Creates the initial clean state for the contract creation form:
 * - Store price (`purchaseRubles`), delivery (`deliveryRubles`), and extra costs (`otherRubles`) are empty by default (`''`)
 * - No tariff profile is selected by default (`planId: ''`)
 * - Term, markup, down payment percent, and monthly payment day are empty by default
 * - Custom actual down payment toggle is OFF by default
 * - No previous client data is pre-filled into the new client fields
 */
export function createInitialContractTermsState(): Required<ContractTermsDraftState> {
  return {
    purchaseRubles: '',
    deliveryRubles: '',
    otherRubles: '',
    planId: '',
    termMonths: '',
    markupMode: 'percent',
    markupPercent: '',
    markupRubles: '',
    downPaymentMode: 'percent',
    downPaymentPercent: '',
    downPaymentRubles: '',
    paymentDayOfMonth: '',
    roundingRule: 'kopeck',
    useCustomActualDownPayment: false,
    actualDownPaymentRubles: '',
  };
}

export function createInitialContractClientState<TGuarantor = unknown>(
  hasExistingClients: boolean
): ContractClientDraftState<TGuarantor> {
  return {
    clientMode: hasExistingClients ? 'existing' : 'new',
    clientId: '',
    clientNameQuery: '',
    payerLastName: '',
    payerFirstName: '',
    payerPatronymic: '',
    newClientPhone: '',
    newClientSecondaryPhone: '',
    newClientDocumentRef: '',
    newClientAddress: '',
    newClientNotes: '',
    allowSimilarName: false,
    showSuggestions: false,
    guarantors: [],
  };
}

/**
 * Transitions the contract form to "New Client" mode, completely clearing
 * ФИО, phone, passport, address, notes, and guarantors from any previously selected client.
 */
export function switchContractFormToNewClient<TGuarantor = unknown>(
  _prev?: Partial<ContractClientDraftState<TGuarantor>>
): ContractClientDraftState<TGuarantor> {
  return {
    clientMode: 'new',
    clientId: '',
    clientNameQuery: '',
    payerLastName: '',
    payerFirstName: '',
    payerPatronymic: '',
    newClientPhone: '',
    newClientSecondaryPhone: '',
    newClientDocumentRef: '',
    newClientAddress: '',
    newClientNotes: '',
    allowSimilarName: false,
    showSuggestions: false,
    guarantors: [],
  };
}

/**
 * Transitions the contract form to "Existing Client" mode.
 * If a specific client is provided, populates strictly that client's fields.
 * If no client is provided yet, clears any draft new-client inputs so data never mixes.
 */
export function switchContractFormToExistingClient<TGuarantor = unknown>(
  selectedClient: ClientDTO | null,
  existingGuarantors: TGuarantor[] = []
): ContractClientDraftState<TGuarantor> {
  if (!selectedClient) {
    return {
      clientMode: 'existing',
      clientId: '',
      clientNameQuery: '',
      payerLastName: '',
      payerFirstName: '',
      payerPatronymic: '',
      newClientPhone: '',
      newClientSecondaryPhone: '',
      newClientDocumentRef: '',
      newClientAddress: '',
      newClientNotes: '',
      allowSimilarName: false,
      showSuggestions: false,
      guarantors: [],
    };
  }

  const parts = splitFullNameParts(selectedClient.fullName);
  return {
    clientMode: 'existing',
    clientId: selectedClient.id,
    clientNameQuery: selectedClient.fullName,
    payerLastName: parts.lastName,
    payerFirstName: parts.firstName,
    payerPatronymic: parts.patronymic,
    newClientPhone: '',
    newClientSecondaryPhone: selectedClient.secondaryPhone || '',
    newClientDocumentRef: selectedClient.documentRef || '',
    newClientAddress: selectedClient.address || '',
    newClientNotes: '',
    allowSimilarName: false,
    showSuggestions: false,
    guarantors: existingGuarantors,
  };
}

/**
 * Applies a selected tariff profile to the contract terms state.
 * If `selectedPlanId` is empty (''), clears `planId` while keeping manual fields editable.
 */
export function applyTariffProfileToContractTerms(
  prev: ContractTermsDraftState,
  selectedPlanId: string,
  plans: InstallmentPlanDTO[]
): ContractTermsDraftState {
  if (!selectedPlanId) {
    return {
      ...prev,
      planId: '',
    };
  }
  const found = plans.find((p) => p.id === selectedPlanId);
  if (!found) {
    return {
      ...prev,
      planId: selectedPlanId,
    };
  }
  return {
    ...prev,
    planId: found.id,
    termMonths: String(found.termMonths),
    markupMode: 'percent',
    markupPercent: String(found.markupPercent),
    markupRubles: '',
    downPaymentMode: 'percent',
    downPaymentPercent: String(found.downPaymentPercent),
    downPaymentRubles: '',
    roundingRule: found.roundingRule,
  };
}

export interface ContractConditionsValidation {
  valid: boolean;
  readyForPreview: boolean;
  error: string | null;
  parsedTermMonths?: number;
  parsedMarkupPercent?: number;
  parsedMarkupKopecks?: number;
  parsedDownPaymentPercent?: number;
  parsedFixedDownPaymentKopecks?: number;
  parsedPaymentDayOfMonth?: number;
}

/**
 * Validates required installment conditions (term, markup, down payment, and monthly payment day 1..31).
 */
export function validateContractTermsState(state: ContractTermsDraftState): ContractConditionsValidation {
  const termRaw = state.termMonths.trim();
  const markupMode = state.markupMode || 'percent';
  const markupRaw = state.markupPercent.trim();
  const markupRublesRaw = (state.markupRubles || '').trim();
  const dpMode = state.downPaymentMode || 'percent';
  const dpRaw = state.downPaymentPercent.trim();
  const dpRublesRaw = (state.downPaymentRubles || '').trim();
  const dayRaw = state.paymentDayOfMonth.trim();

  if (!termRaw) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Укажите срок рассрочки в месяцах (от 1 до 120) или выберите тарифный профиль.',
    };
  }
  const termMonths = Number(termRaw);
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Срок рассрочки должен быть целым числом от 1 до 120 месяцев.',
    };
  }

  let markupPercent = 0;
  let parsedMarkupKopecks: number | undefined;
  if (markupMode === 'fixed') {
    if (!markupRublesRaw) {
      return {
        valid: false,
        readyForPreview: false,
        error: 'Укажите сумму наценки в рублях (не менее 0 ₽).',
      };
    }
    const markupRubNum = Number(markupRublesRaw.replace(',', '.'));
    if (!Number.isFinite(markupRubNum) || markupRubNum < 0) {
      return {
        valid: false,
        readyForPreview: false,
        error: 'Сумма наценки должна быть неотрицательным числом.',
      };
    }
    parsedMarkupKopecks = Math.round(markupRubNum * 100);
  } else {
    if (!markupRaw) {
      return {
        valid: false,
        readyForPreview: false,
        error: 'Укажите процент наценки (от 0% до 500%) или выберите тарифный профиль.',
      };
    }
    markupPercent = Number(markupRaw.replace(',', '.'));
    if (!Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 500) {
      return {
        valid: false,
        readyForPreview: false,
        error: 'Процент наценки должен быть в диапазоне от 0% до 500%.',
      };
    }
  }

  let downPaymentPercent = 0;
  let parsedFixedDownPaymentKopecks: number | undefined;

  if (dpMode === 'fixed') {
    if (!dpRublesRaw) {
      if (!state.useCustomActualDownPayment) {
        return {
          valid: false,
          readyForPreview: false,
          error: 'Укажите фиксированную сумму первоначального взноса в рублях (от 0 ₽).',
        };
      }
      parsedFixedDownPaymentKopecks = 0;
    } else {
      const dpRubNum = Number(dpRublesRaw.replace(',', '.'));
      if (!Number.isFinite(dpRubNum) || dpRubNum < 0) {
        return {
          valid: false,
          readyForPreview: false,
          error: 'Сумма первоначального взноса не может быть отрицательной.',
        };
      }
      parsedFixedDownPaymentKopecks = Math.round(dpRubNum * 100);
    }
  } else {
    if (!dpRaw) {
      if (!state.useCustomActualDownPayment) {
        return {
          valid: false,
          readyForPreview: false,
          error: 'Укажите процент первоначального взноса (от 0% до 99,99%) или выберите тарифный профиль.',
        };
      }
      downPaymentPercent = 0;
    } else {
      downPaymentPercent = Number(dpRaw.replace(',', '.'));
      if (!Number.isFinite(downPaymentPercent) || downPaymentPercent < 0 || downPaymentPercent >= 100) {
        return {
          valid: false,
          readyForPreview: false,
          error: 'Процент первоначального взноса должен быть от 0% до 99,99%.',
        };
      }
    }
  }

  if (!dayRaw) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Выберите дату ежемесячного платежа (число месяца от 1 до 31).',
    };
  }
  const paymentDayOfMonth = Number(dayRaw);
  if (!Number.isInteger(paymentDayOfMonth) || paymentDayOfMonth < 1 || paymentDayOfMonth > 31) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Дата ежемесячного платежа должна быть целым числом от 1 до 31.',
    };
  }

  return {
    valid: true,
    readyForPreview: true,
    error: null,
    parsedTermMonths: termMonths,
    parsedMarkupPercent: markupPercent,
    parsedMarkupKopecks,
    parsedDownPaymentPercent: downPaymentPercent,
    parsedFixedDownPaymentKopecks,
    parsedPaymentDayOfMonth: paymentDayOfMonth,
  };
}

/**
 * Always returns the safe neutral welcome screen ('dashboard') on launch, reload, or login.
 * Never restores confidential sections (such as clients, contracts, payments, or reports)
 * from URL hashes, sessionStorage, or localStorage.
 */
export function getSafeInitialLaunchSection(
  _urlHash?: string | null,
  _storedSection?: string | null
): 'dashboard' {
  return 'dashboard';
}

/**
 * Determines whether confidential business data (/api/v1/state: clients, contracts, payments, balances)
 * should be fetched. On the welcome screen ('dashboard') with no operational modal open,
 * returns false so confidential client/financial data is never loaded or flashed on startup.
 */
export function shouldLoadConfidentialState(params: {
  isAuthenticated: boolean;
  activeSection: string;
  hasOpenOperationalModal?: boolean;
}): boolean {
  if (!params.isAuthenticated) {
    return false;
  }
  if (params.hasOpenOperationalModal) {
    return true;
  }
  return params.activeSection !== 'dashboard';
}

/**
 * Formats the neutral welcome greeting for the home screen, including the owner/user name if available.
 */
export function formatWelcomeGreeting(userFullName?: string | null): string {
  const cleaned = (userFullName || '').trim();
  if (!cleaned) {
    return 'Добро пожаловать';
  }
  return `Добро пожаловать, ${cleaned}`;
}

export type AppSectionId =
  | 'upcoming_payments'
  | 'dashboard'
  | 'clients'
  | 'contracts'
  | 'whatsapp_contracts'
  | 'payments'
  | 'overdues'
  | 'purchases'
  | 'suppliers'
  | 'cash_bank'
  | 'expenses'
  | 'reports'
  | 'documents'
  | 'users'
  | 'installment_settings'
  | 'security_settings';

export const NAV_SECTIONS: Array<{
  id: AppSectionId;
  label: string;
  group: string;
  ownerOnly?: boolean;
}> = [
  { id: 'upcoming_payments', label: 'Ближайшие платежи', group: 'Операционный контур' },
  { id: 'dashboard', label: '1. Главный экран', group: 'Операционный контур' },
  { id: 'clients', label: '2. Клиенты и статусы', group: 'Операционный контур' },
  { id: 'contracts', label: '3. Договоры и графики', group: 'Операционный контур' },
  { id: 'whatsapp_contracts', label: 'Найти и отправить договор', group: 'Операционный контур' },
  { id: 'payments', label: '4. Платежи и распределение', group: 'Операционный контур' },
  { id: 'overdues', label: '5. Просрочки и контакты', group: 'Операционный контур' },
  { id: 'purchases', label: '6. Закупки и товары', group: 'Закупки и склад' },
  { id: 'suppliers', label: '7. Магазины и поставщики', group: 'Закупки и склад' },
  { id: 'cash_bank', label: '8. Касса и банковские счета', group: 'Финансы и отчётность' },
  { id: 'expenses', label: '9. Операционные расходы', group: 'Финансы и отчётность' },
  { id: 'reports', label: '10. Прибыль и отчёты', group: 'Финансы и отчётность' },
  { id: 'documents', label: '11. Документы и шаблоны', group: 'Финансы и отчётность' },
  { id: 'users', label: '12. Пользователи и права', group: 'Управление и защита', ownerOnly: true },
  { id: 'installment_settings', label: '13. Настройки рассрочки', group: 'Управление и защита' },
  { id: 'security_settings', label: '14. Настройки безопасности', group: 'Управление и защита', ownerOnly: true },
];

export function getLocalTodayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function calculateDaysUntilDue(dueDateIso: string, todayIso: string): number {
  const [dueY, dueM, dueD] = dueDateIso.slice(0, 10).split('-').map(Number);
  const [todY, todM, todD] = todayIso.slice(0, 10).split('-').map(Number);
  const dueUtc = Date.UTC(dueY, (dueM || 1) - 1, dueD || 1);
  const todUtc = Date.UTC(todY, (todM || 1) - 1, todD || 1);
  return Math.round((dueUtc - todUtc) / (1000 * 60 * 60 * 24));
}

export type UpcomingPaymentUrgency = 'today' | 'soon' | 'overdue';

export type UpcomingPaymentStatusLabel =
  | 'Сегодня'
  | 'Завтра'
  | 'Через 2 дня'
  | 'Просрочено';

export interface UpcomingPaymentReminderItem {
  scheduleItemId: string;
  contractId: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  dueDate: string;
  remainingKopecks: number;
  daysUntilDue: number;
  urgency: UpcomingPaymentUrgency;
  statusLabel: UpcomingPaymentStatusLabel;
}

/**
 * Dynamically computes upcoming and overdue unpaid schedule installments
 * directly from active/restructured contracts and their current schedules:
 * - Shows installments due in 2 days ('Через 2 дня'), 1 day ('Завтра'), today ('Сегодня'),
 *   or past due ('Просрочено') if not yet paid in full.
 * - Automatically excludes fully paid installments (remainingKopecks <= 0).
 * - For partially paid installments, returns only the remaining unpaid amount (remainingKopecks).
 * - Always uses the contract's current schedule version.
 * - Sorts:
 *   1) Due today (daysUntilDue === 0)
 *   2) Due in 1–2 days (daysUntilDue === 1, then daysUntilDue === 2)
 *   3) Overdue (daysUntilDue < 0, ordered by dueDate ascending)
 */
export function computeUpcomingPaymentReminders(
  contracts: ContractDTO[],
  todayIso: string = getLocalTodayIso()
): UpcomingPaymentReminderItem[] {
  const items: UpcomingPaymentReminderItem[] = [];

  for (const contract of contracts) {
    if (contract.status !== 'active' && contract.status !== 'restructured') {
      continue;
    }
    if (contract.remainingDebtKopecks <= 0) {
      continue;
    }

    const schedule = contract.schedule || [];
    for (const item of schedule) {
      if (
        contract.currentScheduleVersion !== undefined &&
        item.scheduleVersion !== undefined &&
        item.scheduleVersion !== contract.currentScheduleVersion
      ) {
        continue;
      }
      if (item.status === 'paid' || item.status === 'superseded' || item.status === 'waived') {
        continue;
      }

      const remainingKopecks = Math.max(
        0,
        typeof item.remainingKopecks === 'number'
          ? item.remainingKopecks
          : item.plannedKopecks - item.paidKopecks
      );
      if (remainingKopecks <= 0) {
        continue;
      }

      const daysUntilDue = calculateDaysUntilDue(item.dueDate, todayIso);
      if (daysUntilDue > 2) {
        continue;
      }

      let urgency: UpcomingPaymentUrgency;
      let statusLabel: UpcomingPaymentStatusLabel;

      if (daysUntilDue === 0) {
        urgency = 'today';
        statusLabel = 'Сегодня';
      } else if (daysUntilDue === 1) {
        urgency = 'soon';
        statusLabel = 'Завтра';
      } else if (daysUntilDue === 2) {
        urgency = 'soon';
        statusLabel = 'Через 2 дня';
      } else {
        urgency = 'overdue';
        statusLabel = 'Просрочено';
      }

      items.push({
        scheduleItemId: item.id,
        contractId: contract.id,
        clientId: contract.clientId,
        clientName: contract.clientName,
        clientPhone: contract.clientPhone,
        dueDate: item.dueDate,
        remainingKopecks,
        daysUntilDue,
        urgency,
        statusLabel,
      });
    }
  }

  const urgencyRank: Record<UpcomingPaymentUrgency, number> = {
    today: 0,
    soon: 1,
    overdue: 2,
  };

  items.sort((a, b) => {
    const rankDiff = urgencyRank[a.urgency] - urgencyRank[b.urgency];
    if (rankDiff !== 0) return rankDiff;

    if (a.daysUntilDue !== b.daysUntilDue) {
      return a.daysUntilDue - b.daysUntilDue;
    }

    return a.clientName.localeCompare(b.clientName, 'ru');
  });

  return items;
}


