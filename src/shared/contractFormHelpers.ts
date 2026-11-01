import { ClientDTO, InstallmentPlanDTO, RoundingRule } from './types';

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
  markupPercent: string;
  downPaymentPercent: string;
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
    markupPercent: '',
    downPaymentPercent: '',
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
    markupPercent: String(found.markupPercent),
    downPaymentPercent: String(found.downPaymentPercent),
    roundingRule: found.roundingRule,
  };
}

export interface ContractConditionsValidation {
  valid: boolean;
  readyForPreview: boolean;
  error: string | null;
  parsedTermMonths?: number;
  parsedMarkupPercent?: number;
  parsedDownPaymentPercent?: number;
  parsedPaymentDayOfMonth?: number;
}

/**
 * Validates required installment conditions (term, markup, down payment, and monthly payment day 1..31).
 */
export function validateContractTermsState(state: ContractTermsDraftState): ContractConditionsValidation {
  const termRaw = state.termMonths.trim();
  const markupRaw = state.markupPercent.trim();
  const dpRaw = state.downPaymentPercent.trim();
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

  if (!markupRaw) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Укажите процент наценки (от 0% до 500%) или выберите тарифный профиль.',
    };
  }
  const markupPercent = Number(markupRaw);
  if (!Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 500) {
    return {
      valid: false,
      readyForPreview: false,
      error: 'Процент наценки должен быть в диапазоне от 0% до 500%.',
    };
  }

  let downPaymentPercent = 0;
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
    downPaymentPercent = Number(dpRaw);
    if (!Number.isFinite(downPaymentPercent) || downPaymentPercent < 0 || downPaymentPercent >= 100) {
      return {
        valid: false,
        readyForPreview: false,
        error: 'Процент первоначального взноса должен быть от 0% до 99,99%.',
      };
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
    parsedDownPaymentPercent: downPaymentPercent,
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

