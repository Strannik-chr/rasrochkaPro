import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AuditLogDTO,
  BackupDTO,
  ClientDTO,
  ClientPaymentStatus,
  ContractDTO,
  DocumentDTO,
  FinancialAccountDTO,
  InstallmentPlanDTO,
  LedgerEntryDTO,
  OverdueItemDTO,
  PaymentDTO,
  PurchaseDTO,
  ReconciliationResultDTO,
  RoundingRule,
  SettingHistoryDTO,
  StatusRulesConfigDTO,
  SupplierDTO,
  UserDTO,
  UserRole,
} from './shared/types';
import {
  formatDateRu,
  formatDateTimeRu,
  formatMoney,
  getClientPaymentStatusMeta,
  getClientStatusSortWeight,
  parseRublesInputToKopecks,
  translateContractStatus,
  translateEntryType,
  translateRoundingRule,
  translateScheduleStatus,
} from './utils/format';
import {
  EarlyPayoffModal,
  NewContractModal,
  PrintableDocumentModal,
  RestructureScheduleModal,
} from './components/ContractModals';
import {
  ClientDetailsModal,
  DocumentPreviewModal,
  FindAndSendContractSection,
  QuickCallAndCopyBar,
  StatusRulesConfigCard,
} from './components/ClientAndWhatsAppViews';
import { buildDirectWhatsAppUrl } from './shared/clientStatus';
import { ManualAllocationModal, NewPaymentModal } from './components/PaymentAllocateModal';
import { AuthGateModal } from './components/AuthGateModal';
import {
  Search,
  Plus,
  Download,
  Eye,
  Printer,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Menu,
  X,
  RotateCcw,
  Calculator,
  History,
  FileText,
  Lock,
  Upload,
  RefreshCw,
  MessageCircle,
  Paperclip,
  Trash2,
} from 'lucide-react';

type SectionId =
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

const NAV_SECTIONS: Array<{ id: SectionId; label: string; group: string; ownerOnly?: boolean }> = [
  { id: 'dashboard', label: '1. Главная панель', group: 'Операционный контур' },
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

export default function App() {
  const [currentUser, setCurrentUser] = useState<{
    id: string;
    email: string;
    phone: string;
    fullName: string;
    role: UserRole;
    status: string;
    mustChangePassword?: boolean;
    passwordChangedAt?: string | null;
    mfaEnabled: boolean;
  } | null>(null);
  const [csrfToken, setCsrfToken] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [activeSection, setActiveSection] = useState<SectionId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Period filter for reports & ledger
  const [periodFrom, setPeriodFrom] = useState('2026-07-01');
  const [periodTo, setPeriodTo] = useState('2026-12-31');

  // Application state from relational DB
  const [plans, setPlans] = useState<InstallmentPlanDTO[]>([]);
  const [settingsHistory, setSettingsHistory] = useState<SettingHistoryDTO[]>([]);
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierDTO[]>([]);
  const [purchases, setPurchases] = useState<PurchaseDTO[]>([]);
  const [contracts, setContracts] = useState<ContractDTO[]>([]);
  const [payments, setPayments] = useState<PaymentDTO[]>([]);
  const [overdues, setOverdues] = useState<OverdueItemDTO[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountDTO[]>([]);
  const [ledger, setLedger] = useState<LedgerEntryDTO[]>([]);
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [users, setUsers] = useState<UserDTO[]>([]);
  const [backups, setBackups] = useState<BackupDTO[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogDTO[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationResultDTO | null>(null);
  const [statusRules, setStatusRules] = useState<StatusRulesConfigDTO | null>(null);

  // Client filter, search & sort state
  const [clientStatusFilter, setClientStatusFilter] = useState<'all' | ClientPaymentStatus>('all');
  const [clientSortBy, setClientSortBy] = useState<
    'status_severity' | 'debt_desc' | 'overdue_desc' | 'name_asc'
  >('status_severity');
  const [viewingClientCardId, setViewingClientCardId] = useState<string | null>(null);
  const [whatsappTargetContractId, setWhatsappTargetContractId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [bannerNotice, setBannerNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  // Modals
  const [showNewContractModal, setShowNewContractModal] = useState(false);
  const [earlyPayoffContract, setEarlyPayoffContract] = useState<ContractDTO | null>(null);
  const [restructureContract, setRestructureContract] = useState<ContractDTO | null>(null);
  const [printTemplateModal, setPrintTemplateModal] = useState<{
    contract: ContractDTO;
    type: 'contract' | 'schedule' | 'handover' | 'payoff';
  } | null>(null);
  const [allocatingPayment, setAllocatingPayment] = useState<PaymentDTO | null>(null);
  const [showNewPaymentModal, setShowNewPaymentModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Inline form states for sections
  const [clientForm, setClientForm] = useState({
    fullName: '',
    phone: '',
    secondaryPhone: '',
    documentRef: '',
    address: '',
    notes: '',
  });
  const [supplierForm, setSupplierForm] = useState({
    name: '',
    category: 'Магазин электроники',
    contactInfo: '',
    notes: '',
  });
  const [purchaseForm, setPurchaseForm] = useState({
    supplierId: '',
    clientId: '',
    itemName: '',
    itemCategory: 'Смартфоны и электроника',
    purchaseRubles: '',
    deliveryRubles: '0',
    otherRubles: '0',
    paidSupplierRubles: '',
    paymentAccountId: 'acc_bank_main',
    purchaseDate: new Date().toISOString().slice(0, 10),
    notes: '',
  });
  const [ledgerForm, setLedgerForm] = useState({
    accountId: 'acc_cash_main',
    targetAccountId: 'acc_bank_main',
    entryType: 'operating_expense' as
      | 'operating_expense'
      | 'owner_injection'
      | 'owner_withdrawal'
      | 'internal_transfer',
    category: 'Аренда и операционные расходы',
    amountRubles: '',
    description: '',
    eventDate: new Date().toISOString().slice(0, 10),
  });
  const [overdueContactForm, setOverdueContactForm] = useState<{
    scheduleItemId: string;
    contractId: string;
    contactChannel: 'phone' | 'messenger' | 'in_person';
    summary: string;
    promisedDate: string;
    agreedNewDueDate: string;
  } | null>(null);

  const [newPlanForm, setNewPlanForm] = useState({
    name: '',
    termMonths: '9',
    markupPercent: '29',
    downPaymentPercent: '30',
    roundingRule: 'kopeck' as RoundingRule,
    earlyPayoffDiscountPercent: '30',
    reason: 'Добавление нового гибкого срока рассрочки через админ-панель',
  });
  const [editingPlan, setEditingPlan] = useState<{
    id: string;
    name: string;
    termMonths: string;
    markupPercent: string;
    downPaymentPercent: string;
    roundingRule: RoundingRule;
    earlyPayoffDiscountPercent: string;
    isActive: boolean;
    reason: string;
  } | null>(null);

  const [mfaSetupInfo, setMfaSetupInfo] = useState<{
    secret: string;
    otpauthUrl: string;
    currentSampleCode: string;
  } | null>(null);
  const [mfaConfirmCode, setMfaConfirmCode] = useState('');

  // Admin User Management & Password Change states
  const [adminNewUserForm, setAdminNewUserForm] = useState({
    phone: '',
    password: '',
    fullName: '',
    role: 'staff' as UserRole,
    mustChangePassword: false,
  });
  const [editingUser, setEditingUser] = useState<{
    id: string;
    phone: string;
    fullName: string;
    role: UserRole;
  } | null>(null);
  const [resetPasswordModal, setResetPasswordModal] = useState<{
    id: string;
    phone: string;
    newPassword: string;
    mustChangePassword: boolean;
  } | null>(null);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [passwordChangeDismissed, setPasswordChangeDismissed] = useState(false);
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [selfPasswordForm, setSelfPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
  });
  const [editingClient, setEditingClient] = useState<{
    id: string;
    fullName: string;
    phone: string;
    secondaryPhone: string;
    documentRef: string;
    address: string;
    notes: string;
    status: 'active' | 'archived';
  } | null>(null);

  const [previewingDocument, setPreviewingDocument] = useState<DocumentDTO | null>(null);
  const [confirmDeleteContractDocId, setConfirmDeleteContractDocId] = useState<string | null>(null);
  const [confirmRemoveGuarantorId, setConfirmRemoveGuarantorId] = useState<string | null>(null);
  const [confirmCleanResetDb, setConfirmCleanResetDb] = useState(false);

  const fetchProtectedBlob = useCallback(
    async (path: string): Promise<Blob> => {
      const headers: Record<string, string> = {};
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      if (sessionToken) headers['X-Session-Token'] = sessionToken;
      const res = await fetch(path, {
        method: 'GET',
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        let errMsg = `Ошибка загрузки файла (${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) errMsg = data.error;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }
      return res.blob();
    },
    [csrfToken, sessionToken]
  );

  const downloadProtectedFile = useCallback(
    async (path: string, fallbackFilename: string) => {
      const blob = await fetchProtectedBlob(path);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = fallbackFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    },
    [fetchProtectedBlob]
  );

  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      if (sessionToken) {
        headers['X-Session-Token'] = sessionToken;
      }
      const res = await fetch(path, {
        ...options,
        credentials: 'include',
        headers,
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Ошибка запроса (${res.status})`);
        }
        return data;
      }
      if (!res.ok) {
        throw new Error(`Ошибка сервера (${res.status})`);
      }
      return res.text();
    },
    [csrfToken, sessionToken]
  );

  const loadFullState = useCallback(
    async (activeCsrf?: string, activeSessToken?: string) => {
      const tokenToUse = activeCsrf ?? csrfToken;
      const sessToUse = activeSessToken ?? sessionToken;
      const headers: Record<string, string> = {};
      if (tokenToUse) headers['X-CSRF-Token'] = tokenToUse;
      if (sessToUse) headers['X-Session-Token'] = sessToUse;

      const res = await fetch('/api/v1/state', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        throw new Error('Не удалось загрузить данные системы.');
      }
      const data = await res.json();
      setPlans(data.plans || []);
      setSettingsHistory(data.settingsHistory || []);
      setClients(data.clients || []);
      setSuppliers(data.suppliers || []);
      setPurchases(data.purchases || []);
      setContracts(data.contracts || []);
      setPayments(data.payments || []);
      setOverdues(data.overdues || []);
      setAccounts(data.accounts || []);
      setLedger(data.ledger || []);
      setDocuments(data.documents || []);
      setUsers(data.users || []);
      setBackups(data.backups || []);
      setAuditLogs(data.auditLogs || []);
      setReconciliation(data.reconciliation || null);
      if (data.statusRules) {
        setStatusRules(data.statusRules);
      }
    },
    [csrfToken, sessionToken]
  );

  const initializeSessionAndData = useCallback(async () => {
    setLoading(true);
    try {
      const sessRes = await fetch('/api/v1/auth/session', {
        credentials: 'include',
        headers: sessionToken ? { 'X-Session-Token': sessionToken } : {},
      });
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        if (sessData.authenticated && sessData.user) {
          setCurrentUser(sessData.user);
          setCsrfToken(sessData.csrfToken || '');
          if (sessData.sessionToken) {
            setSessionToken(sessData.sessionToken);
          }
          await loadFullState(sessData.csrfToken || '', sessData.sessionToken || sessionToken);
        } else {
          setCurrentUser(null);
        }
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setLoading(false);
    }
  }, [loadFullState, sessionToken]);

  useEffect(() => {
    initializeSessionAndData();
  }, []);

  const notify = (type: 'success' | 'error', text: string) => {
    setBannerNotice({ type, text });
    setTimeout(() => {
      setBannerNotice((prev) => (prev?.text === text ? null : prev));
    }, 6000);
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // clear local auth state regardless
    }
    setCurrentUser(null);
    setCsrfToken('');
    setSessionToken('');
    setShowAuthModal(false);
  };

  // Computed financial metrics (strictly separating Cash Flow, Owner Capital, COGS, and Management Profit)
  const financialMetrics = useMemo(() => {
    const totalCashKopecks = accounts
      .filter((a) => a.accountType === 'cash')
      .reduce((s, a) => s + a.balanceKopecks, 0);
    const totalBankKopecks = accounts
      .filter((a) => a.accountType === 'bank')
      .reduce((s, a) => s + a.balanceKopecks, 0);

    const activeContracts = contracts.filter(
      (c) => c.status === 'active' || c.status === 'restructured' || c.status === 'completed'
    );
    const portfolioSaleVolumeKopecks = activeContracts.reduce((s, c) => s + c.salePriceKopecks, 0);
    const portfolioCostOfGoodsKopecks = activeContracts.reduce((s, c) => s + c.totalCostKopecks, 0);
    const totalExpectedMarkupKopecks = activeContracts.reduce(
      (s, c) => s + (c.salePriceKopecks - c.totalCostKopecks - c.closingDiscountKopecks),
      0
    );

    const totalClientDebtKopecks = contracts
      .filter((c) => c.status === 'active' || c.status === 'restructured')
      .reduce((s, c) => s + c.remainingDebtKopecks, 0);

    const totalOverdueKopecks = overdues.reduce((s, o) => s + o.overdueKopecks, 0);
    const totalUnallocatedPaymentsKopecks = payments
      .filter((p) => p.status === 'confirmed')
      .reduce((s, p) => s + p.unallocatedKopecks, 0);

    const supplierObligationsKopecks = purchases.reduce((s, p) => s + p.supplierDebtKopecks, 0);

    // Period-filtered ledger metrics
    const periodLedger = ledger.filter(
      (l) => l.status === 'confirmed' && l.eventDate >= periodFrom && l.eventDate <= periodTo
    );

    const clientInflowsKopecks = periodLedger
      .filter((l) => l.entryType === 'client_payment')
      .reduce((s, l) => s + l.amountKopecks, 0);

    const purchaseOutflowsKopecks = periodLedger
      .filter((l) => l.entryType === 'purchase_payment' || l.entryType === 'delivery_expense')
      .reduce((s, l) => s + l.amountKopecks, 0);

    const operatingExpensesKopecks = periodLedger
      .filter((l) => l.entryType === 'operating_expense')
      .reduce((s, l) => s + l.amountKopecks, 0);

    const ownerInjectionsKopecks = periodLedger
      .filter((l) => l.entryType === 'owner_injection')
      .reduce((s, l) => s + l.amountKopecks, 0);

    const ownerWithdrawalsKopecks = periodLedger
      .filter((l) => l.entryType === 'owner_withdrawal')
      .reduce((s, l) => s + l.amountKopecks, 0);

    const internalTransfersKopecks = periodLedger
      .filter((l) => l.entryType === 'internal_transfer_out')
      .reduce((s, l) => s + l.amountKopecks, 0);

    // Realized markup in collected payments vs operating expenses
    const realizedGrossMarginKopecks = activeContracts.reduce((sum, c) => {
      if (c.salePriceKopecks <= 0) return sum;
      const effectiveMarkup = Math.max(0, c.salePriceKopecks - c.totalCostKopecks - c.closingDiscountKopecks);
      const collectedRatio = Math.min(1, c.totalCollectedKopecks / c.salePriceKopecks);
      return sum + Math.round(effectiveMarkup * collectedRatio);
    }, 0);

    const managementNetProfitKopecks = realizedGrossMarginKopecks - operatingExpensesKopecks;

    return {
      totalCashKopecks,
      totalBankKopecks,
      totalLiquidityKopecks: totalCashKopecks + totalBankKopecks,
      portfolioSaleVolumeKopecks,
      portfolioCostOfGoodsKopecks,
      totalExpectedMarkupKopecks,
      totalClientDebtKopecks,
      totalOverdueKopecks,
      totalUnallocatedPaymentsKopecks,
      supplierObligationsKopecks,
      clientInflowsKopecks,
      purchaseOutflowsKopecks,
      operatingExpensesKopecks,
      ownerInjectionsKopecks,
      ownerWithdrawalsKopecks,
      internalTransfersKopecks,
      realizedGrossMarginKopecks,
      managementNetProfitKopecks,
    };
  }, [accounts, contracts, overdues, payments, purchases, ledger, periodFrom, periodTo]);

  const isOwner = currentUser?.role === 'owner';
  const canWrite = currentUser?.role === 'owner' || currentUser?.role === 'staff';

  // Separate borrowers ("рассрочники") from pure guarantors ("поручители") so tables don't mix them
  const borrowerClients = useMemo(
    () =>
      clients.filter((cl) => {
        const hasOwnContracts =
          (cl.activeContractsCount ?? 0) > 0 ||
          (cl.completedContractsCount ?? 0) > 0 ||
          contracts.some((c) => c.clientId === cl.id);
        const isPureGuarantor = !hasOwnContracts && (cl.guarantorContracts?.length || 0) > 0;
        return !isPureGuarantor;
      }),
    [clients, contracts]
  );

  // Filtered lists by searchQuery
  const q = searchQuery.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const filteredContracts = contracts.filter(
    (c) =>
      !q ||
      c.contractNumber.toLowerCase().includes(q) ||
      c.clientName.toLowerCase().includes(q) ||
      c.clientPhone.toLowerCase().includes(q) ||
      (qDigits.length >= 3 && c.clientPhone.replace(/\D/g, '').includes(qDigits)) ||
      c.itemTitle.toLowerCase().includes(q) ||
      (c.guarantors || []).some(
        (g) =>
          g.fullName.toLowerCase().includes(q) ||
          g.phone.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && g.phone.replace(/\D/g, '').includes(qDigits))
      )
  );
  const filteredClients = useMemo(() => {
    const base = borrowerClients.filter((c) => {
      if (clientStatusFilter !== 'all' && (c.paymentStatus || 'new') !== clientStatusFilter) {
        return false;
      }
      if (!q) return true;
      const nameMatch = c.fullName.toLowerCase().includes(q);
      const phoneMatch =
        c.phone.toLowerCase().includes(q) ||
        (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits));
      const guarantorMatch = contracts
        .filter((cnt) => cnt.clientId === c.id)
        .some((cnt) =>
          (cnt.guarantors || []).some(
            (g) =>
              g.fullName.toLowerCase().includes(q) ||
              g.phone.toLowerCase().includes(q) ||
              (qDigits.length >= 3 && g.phone.replace(/\D/g, '').includes(qDigits))
          )
        );
      return nameMatch || phoneMatch || guarantorMatch;
    });

    return [...base].sort((a, b) => {
      if (clientSortBy === 'status_severity') {
        const diff =
          getClientStatusSortWeight(a.paymentStatus) - getClientStatusSortWeight(b.paymentStatus);
        if (diff !== 0) return diff;
        return (b.totalOverdueKopecks || 0) - (a.totalOverdueKopecks || 0);
      }
      if (clientSortBy === 'debt_desc') {
        return (b.totalRemainingDebtKopecks || 0) - (a.totalRemainingDebtKopecks || 0);
      }
      if (clientSortBy === 'overdue_desc') {
        return (b.totalOverdueKopecks || 0) - (a.totalOverdueKopecks || 0);
      }
      return a.fullName.localeCompare(b.fullName, 'ru');
    });
  }, [borrowerClients, contracts, clientStatusFilter, clientSortBy, q, qDigits]);
  const filteredPayments = payments.filter(
    (p) =>
      !q ||
      p.clientName.toLowerCase().includes(q) ||
      (p.contractNumber && p.contractNumber.toLowerCase().includes(q)) ||
      p.notes.toLowerCase().includes(q)
  );

  // Handlers
  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/clients', {
        method: 'POST',
        body: JSON.stringify(clientForm),
      });
      setClientForm({
        fullName: '',
        phone: '',
        secondaryPhone: '',
        documentRef: '',
        address: '',
        notes: '',
      });
      await loadFullState();
      notify('success', 'Карточка клиента успешно сохранена.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка создания клиента');
    }
  };

  const handleCreateSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/suppliers', {
        method: 'POST',
        body: JSON.stringify(supplierForm),
      });
      setSupplierForm({ name: '', category: 'Магазин электроники', contactInfo: '', notes: '' });
      await loadFullState();
      notify('success', 'Магазин / поставщик добавлен в справочник.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка добавления поставщика');
    }
  };

  const handleCreatePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const pKop = parseRublesInputToKopecks(purchaseForm.purchaseRubles);
      const dKop = parseRublesInputToKopecks(purchaseForm.deliveryRubles);
      const oKop = parseRublesInputToKopecks(purchaseForm.otherRubles);
      const paidKop =
        purchaseForm.paidSupplierRubles.trim() === ''
          ? pKop
          : parseRublesInputToKopecks(purchaseForm.paidSupplierRubles);

      await apiFetch('/api/v1/purchases', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: purchaseForm.supplierId || suppliers[0]?.id,
          clientId: purchaseForm.clientId || null,
          itemName: purchaseForm.itemName,
          itemCategory: purchaseForm.itemCategory,
          quantity: 1,
          purchasePriceKopecks: pKop,
          deliveryCostKopecks: dKop,
          otherCostKopecks: oKop,
          paidToSupplierKopecks: paidKop,
          paymentAccountId: purchaseForm.paymentAccountId,
          purchaseDate: purchaseForm.purchaseDate,
          notes: purchaseForm.notes,
        }),
      });
      setPurchaseForm((prev) => ({
        ...prev,
        itemName: '',
        purchaseRubles: '',
        deliveryRubles: '0',
        otherRubles: '0',
        paidSupplierRubles: '',
        notes: '',
      }));
      await loadFullState();
      notify('success', 'Закупка зарегистрирована, полная себестоимость и кассовые регистры обновлены.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка создания закупки');
    }
  };

  const handleRecordLedgerOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const amountKop = parseRublesInputToKopecks(ledgerForm.amountRubles);
      await apiFetch('/api/v1/finance/ledger', {
        method: 'POST',
        body: JSON.stringify({
          accountId: ledgerForm.accountId,
          targetAccountId: ledgerForm.targetAccountId,
          entryType: ledgerForm.entryType,
          category: ledgerForm.category,
          amountKopecks: amountKop,
          description: ledgerForm.description,
          eventDate: ledgerForm.eventDate,
        }),
      });
      setLedgerForm((prev) => ({ ...prev, amountRubles: '', description: '' }));
      await loadFullState();
      notify('success', 'Финансовая операция успешно проведена и проверена.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка проведения операции');
    }
  };

  const handleSaveOverdueContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overdueContactForm) return;
    try {
      await apiFetch('/api/v1/overdues/contact', {
        method: 'POST',
        body: JSON.stringify({
          contractId: overdueContactForm.contractId,
          scheduleItemId: overdueContactForm.scheduleItemId,
          contactChannel: overdueContactForm.contactChannel,
          summary: overdueContactForm.summary,
          promisedDate: overdueContactForm.promisedDate || null,
          agreedNewDueDate: overdueContactForm.agreedNewDueDate || null,
        }),
      });
      setOverdueContactForm(null);
      await loadFullState();
      notify('success', 'Контакт с клиентом и обещанная дата оплаты сохранены (штрафы не начислялись).');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка сохранения контакта');
    }
  };

  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/settings/plans', {
        method: 'POST',
        body: JSON.stringify({
          name: newPlanForm.name,
          termMonths: Number(newPlanForm.termMonths),
          markupPercent: Number(newPlanForm.markupPercent),
          downPaymentPercent: Number(newPlanForm.downPaymentPercent),
          downPaymentRequired: true,
          roundingRule: newPlanForm.roundingRule,
          earlyPayoffDiscountPercent: Number(newPlanForm.earlyPayoffDiscountPercent),
          reason: newPlanForm.reason,
        }),
      });
      setNewPlanForm({
        name: '',
        termMonths: '9',
        markupPercent: '29',
        downPaymentPercent: '30',
        roundingRule: 'kopeck',
        earlyPayoffDiscountPercent: '30',
        reason: 'Добавление нового гибкого срока рассрочки через админ-панель',
      });
      await loadFullState();
      notify('success', 'Новый тариф рассрочки сохранён. Он доступен при оформлении новых договоров.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка сохранения тарифа');
    }
  };

  const handleUpdatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPlan) return;
    try {
      await apiFetch(`/api/v1/settings/plans/${editingPlan.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editingPlan.name,
          termMonths: Number(editingPlan.termMonths),
          markupPercent: Number(editingPlan.markupPercent),
          downPaymentPercent: Number(editingPlan.downPaymentPercent),
          roundingRule: editingPlan.roundingRule,
          earlyPayoffDiscountPercent: Number(editingPlan.earlyPayoffDiscountPercent),
          isActive: editingPlan.isActive,
          reason: editingPlan.reason,
        }),
      });
      setEditingPlan(null);
      await loadFullState();
      notify(
        'success',
        'Тариф обновлён с повышением версии. Ранее заключённые договоры сохранили свои исходные условия.'
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка обновления тарифа');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const resultStr = String(reader.result || '');
        const base64 = resultStr.includes(',') ? resultStr.split(',')[1] : resultStr;
        await apiFetch('/api/v1/documents/upload', {
          method: 'POST',
          body: JSON.stringify({
            entityType: 'contract',
            entityId: contracts[0]?.id || 'cnt_01',
            docCategory: 'contract_scan',
            title: `Скан / подтверждение: ${file.name}`,
            originalFilename: file.name,
            mimeType: file.type,
            contentBase64: base64,
          }),
        });
        await loadFullState();
        notify('success', `Файл «${file.name}» прошёл проверку сигнатуры (magic bytes) и сохранён.`);
      } catch (err) {
        notify('error', err instanceof Error ? err.message : 'Ошибка загрузки файла');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleCreateSamplePdfReceipt = async () => {
    try {
      // Minimal valid PDF header (%PDF-1.4) encoded in Base64 for testing magic byte validation
      const pdfString = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF`;
      const base64 = btoa(pdfString);
      await apiFetch('/api/v1/documents/upload', {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'contract',
          entityId: contracts[0]?.id || 'cnt_01',
          docCategory: 'receipt',
          title: `Кассовый чек и подтверждение передачи по договору ${contracts[0]?.contractNumber || 'ДГ-2026-0001'}`,
          originalFilename: 'receipt_verified_scan.pdf',
          mimeType: 'application/pdf',
          contentBase64: base64,
        }),
      });
      await loadFullState();
      notify('success', 'Проверенный PDF-документ (с валидной сигнатурой %PDF) прикреплён к договору.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Ошибка прикрепления документа');
    }
  };

  if (loading && !currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-xs text-slate-500">
        Проверка защищённой сессии...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthGateModal
        fullScreen
        apiFetch={apiFetch}
        onSuccessLogin={async (loginData) => {
          if (loginData?.user) {
            setCurrentUser(loginData.user);
            setCsrfToken(loginData.csrfToken || '');
            setSessionToken(loginData.sessionToken || '');
            await loadFullState(loginData.csrfToken || '', loginData.sessionToken || '');
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A] overflow-x-hidden">
      {/* Top Bar Contract: Zone 1 (Wordmark) — Zone 2 (Quick Top Nav) — Zone 3 (Primary CTA) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 sm:gap-6 px-3 sm:px-6 py-3 bg-white border-b border-slate-200 no-print">
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Открыть меню разделов"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <a
            href="#dashboard"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('dashboard');
            }}
            className="text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
          >
            РассрочкаПро
          </a>
        </div>

        <nav className="hidden xl:flex items-center gap-5 text-xs xl:text-sm font-medium text-slate-600 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSection('dashboard')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'dashboard' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Сводка
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('clients')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'clients' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Клиенты
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('contracts')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'contracts' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Договоры
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('whatsapp_contracts')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
              activeSection === 'whatsapp_contracts'
                ? 'text-emerald-800 underline underline-offset-8 font-semibold'
                : 'text-emerald-700'
            }`}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span>Найти и отправить договор</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('payments')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'payments' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Платежи
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('overdues')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'overdues' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Просрочки
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('installment_settings')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'installment_settings'
                ? 'text-slate-900 underline underline-offset-8'
                : ''
            }`}
          >
            Тарифы рассрочки
          </button>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowNewContractModal(true)}
            disabled={!canWrite}
            className="px-3 sm:px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            Оформить договор
          </button>
        </div>
      </header>

      {/* Main Workspace Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {/* Sidebar Navigation (14 Required Modules) */}
        <aside
          className={`${
            mobileMenuOpen
              ? 'fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] bg-white shadow-xl flex'
              : 'hidden lg:flex lg:w-64'
          } flex-col border-r border-slate-200 bg-white shrink-0 no-print overflow-y-auto`}
        >
          <div className="p-4 border-b border-slate-200 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500 min-w-0 truncate">
                Телефон: <strong className="font-mono text-slate-900">{currentUser.phone || currentUser.fullName}</strong>
              </div>
              {mobileMenuOpen && (
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="lg:hidden p-1 text-slate-400 hover:text-slate-900 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="text-[11px] text-slate-500 truncate">{currentUser.fullName}</div>
            <div className="text-xs text-slate-500 flex items-center justify-between pt-1">
              <span>
                Роль: <span className="font-mono text-slate-800">{currentUser.role}</span>
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setShowChangePasswordModal(true);
                  }}
                  className="text-xs font-medium text-slate-700 hover:text-slate-900 underline"
                >
                  Пароль
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-xs font-medium text-red-700 hover:text-red-900 underline"
                >
                  Выйти
                </button>
              </div>
            </div>
          </div>

          <div className="p-3 space-y-5 flex-1">
            {['Операционный контур', 'Закупки и склад', 'Финансы и отчётность', 'Управление и защита'].map(
              (groupName) => {
                const items = NAV_SECTIONS.filter(
                  (item) => item.group === groupName && (!item.ownerOnly || isOwner)
                );
                if (items.length === 0) return null;
                return (
                  <div key={groupName}>
                    <div className="px-3 mb-1.5 text-[11px] font-semibold text-slate-400">
                      {groupName}
                    </div>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const active = activeSection === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setActiveSection(item.id);
                              setMobileMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors break-words ${
                              active
                                ? 'bg-slate-900 text-white'
                                : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                            }`}
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }
            )}
          </div>

          <div className="p-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
            <div className="flex items-center gap-1.5 text-slate-800 font-medium">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              <span>Точность: целые копейки</span>
            </div>
            <div>
              Сверка регистров:{' '}
              {reconciliation?.isHealthy ? (
                <span className="text-emerald-700 font-medium">Все балансы сходятся</span>
              ) : (
                <span className="text-red-600 font-medium">Есть расхождения</span>
              )}
            </div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 overflow-y-auto p-3 sm:p-6 max-w-[1440px] mx-auto w-full min-w-0 space-y-5 sm:space-y-6">
          {/* Workspace Toolbar: Search & Quick Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 no-print">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Быстрый поиск по клиенту, договору, товару..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewPaymentModal(true)}
                disabled={!canWrite}
                className="flex-1 sm:flex-initial justify-center px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Принять платёж</span>
              </button>
              <button
                type="button"
                onClick={() => loadFullState()}
                className="flex-1 sm:flex-initial justify-center px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:text-slate-900 whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Сверить регистры</span>
              </button>
            </div>
          </div>

          {bannerNotice && (
            <div
              className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
                bannerNotice.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {bannerNotice.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                )}
                <span className="break-words">{bannerNotice.text}</span>
              </div>
              <button onClick={() => setBannerNotice(null)} className="text-slate-500 hover:text-slate-900 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {loading ? (
            <div className="p-12 text-center text-sm text-slate-500">
              Загрузка и проверка целостности финансовых регистров...
            </div>
          ) : (
            <>
              {/* ==================== 1. ГЛАВНАЯ ПАНЕЛЬ ==================== */}
              {activeSection === 'dashboard' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                      Финансовая сводка и контроль задолженностей
                    </h1>
                    <p className="text-xs text-slate-500 mt-1">
                      Все показатели рассчитываются с точностью до копейки. Пополнения собственными средствами и внутренние переводы отделены от выручки и прибыли.
                    </p>
                  </div>

                  {/* Primary Financial Strip */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-4">
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                      <div className="text-xs text-slate-500">
                        Фактические денежные остатки (Касса + Банк)
                      </div>
                      <div className="text-xl sm:text-2xl font-bold font-mono text-slate-900 mt-1.5 break-words">
                        {formatMoney(financialMetrics.totalLiquidityKopecks)}
                      </div>
                      <div className="text-xs text-slate-500 mt-2 font-mono break-words">
                        Наличные: {formatMoney(financialMetrics.totalCashKopecks)} · Банк:{' '}
                        {formatMoney(financialMetrics.totalBankKopecks)}
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                      <div className="text-xs text-slate-500">
                        Общая задолженность клиентов (ожидаемые поступления)
                      </div>
                      <div className="text-xl sm:text-2xl font-bold font-mono text-slate-900 mt-1.5 break-words">
                        {formatMoney(financialMetrics.totalClientDebtKopecks)}
                      </div>
                      <div className="text-xs text-slate-500 mt-2">
                        Активных договоров: {contracts.filter((c) => c.status === 'active' || c.status === 'restructured').length} · Заёмщиков: {borrowerClients.length}
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                      <div className="text-xs text-slate-500">
                        Просроченная задолженность (без авто-штрафов)
                      </div>
                      <div
                        className={`text-xl sm:text-2xl font-bold font-mono mt-1.5 break-words ${
                          financialMetrics.totalOverdueKopecks > 0 ? 'text-red-600' : 'text-emerald-700'
                        }`}
                      >
                        {formatMoney(financialMetrics.totalOverdueKopecks)}
                      </div>
                      <div className="text-xs text-slate-500 mt-2 break-words">
                        Просроченных платежей: {overdues.length} · Нераспределённых поступлений:{' '}
                        <span className="font-mono font-medium text-amber-700">
                          {formatMoney(financialMetrics.totalUnallocatedPaymentsKopecks)}
                        </span>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                      <div className="text-xs text-slate-500">
                        Управленческая прибыль (реализованная наценка − опер. расходы)
                      </div>
                      <div className="text-xl sm:text-2xl font-bold font-mono text-emerald-700 mt-1.5 break-words">
                        {formatMoney(financialMetrics.managementNetProfitKopecks)}
                      </div>
                      <div className="text-xs text-slate-500 mt-2 font-mono break-words">
                        Обязательства поставщикам: {formatMoney(financialMetrics.supplierObligationsKopecks)}
                      </div>
                    </div>
                  </div>

                  {/* Active Contracts Overview Table & Mobile Cards */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="text-sm sm:text-base font-semibold text-slate-900">
                          Действующие договоры рассрочки
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Нажмите на ФИО заёмщика для просмотра его карточки и поручителей
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveSection('contracts')}
                        className="text-xs font-medium text-slate-700 hover:text-slate-900 underline shrink-0"
                      >
                        Все договоры ({contracts.length})
                      </button>
                    </div>

                    {/* Mobile Card View */}
                    <div className="md:hidden divide-y divide-slate-100">
                      {filteredContracts.map((c) => {
                        const waDirectUrl = buildDirectWhatsAppUrl(c.clientPhone);
                        return (
                          <div key={c.id} className="p-4 space-y-3 text-xs">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() => setViewingClientCardId(c.clientId)}
                                  className="text-sm font-bold text-slate-900 hover:underline text-left break-words"
                                >
                                  {c.clientName}
                                </button>
                                <div className="text-slate-600 mt-0.5 break-words">
                                  {c.itemTitle}
                                </div>
                                <div className="font-mono text-[11px] text-slate-500 mt-0.5">
                                  {c.contractNumber} · от {formatDateRu(c.startDate)} · {c.termMonths} мес. ({c.markupPercent}%)
                                </div>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2 p-2.5 bg-slate-50 rounded-lg font-mono text-[11px]">
                              <div>
                                <div className="font-sans text-slate-500">Себестоимость</div>
                                <div className="text-slate-800">{formatMoney(c.totalCostKopecks)}</div>
                              </div>
                              <div>
                                <div className="font-sans text-slate-500">Цена продажи</div>
                                <div className="font-semibold text-slate-900">{formatMoney(c.salePriceKopecks)}</div>
                              </div>
                              <div>
                                <div className="font-sans text-slate-500">Внесено всего</div>
                                <div className="text-emerald-700 font-medium">{formatMoney(c.totalCollectedKopecks)}</div>
                              </div>
                              <div>
                                <div className="font-sans text-slate-500">Остаток долга</div>
                                <div className="font-bold text-slate-900">{formatMoney(c.remainingDebtKopecks)}</div>
                                {c.overdueKopecks > 0 && (
                                  <div className="text-red-600 text-[10px]">
                                    Просрочка: {formatMoney(c.overdueKopecks)}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setViewingClientCardId(c.clientId)}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-300 rounded-lg"
                              >
                                Карточка / Поручители ({c.guarantors?.length || 0})
                              </button>
                              {waDirectUrl && (
                                <a
                                  href={waDirectUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-2.5 py-1.5 text-xs font-medium text-white bg-emerald-600 border border-emerald-700 rounded-lg inline-flex items-center gap-1"
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                  <span>WA</span>
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => setEarlyPayoffContract(c)}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg"
                              >
                                Досрочное
                              </button>
                              <button
                                type="button"
                                onClick={() => setRestructureContract(c)}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg"
                              >
                                График (v{c.currentScheduleVersion})
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop Table View */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">Договор и дата</th>
                            <th className="py-3 px-4 font-medium">Заёмщик и товар</th>
                            <th className="py-3 px-4 font-medium text-right">Себестоимость</th>
                            <th className="py-3 px-4 font-medium text-right">Цена продажи</th>
                            <th className="py-3 px-4 font-medium text-right">Внесено всего</th>
                            <th className="py-3 px-4 font-medium text-right">Остаток долга</th>
                            <th className="py-3 px-4 font-medium text-right">Действия</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredContracts.map((c) => {
                            const waDirectUrl = buildDirectWhatsAppUrl(c.clientPhone);
                            return (
                              <tr key={c.id} className="hover:bg-slate-50/80">
                                <td className="py-3 px-4">
                                  <div className="font-mono font-semibold text-slate-900">
                                    {c.contractNumber}
                                  </div>
                                  <div className="text-slate-500 mt-0.5">
                                    {formatDateRu(c.startDate)} · {c.termMonths} мес. · Наценка{' '}
                                    {c.markupPercent}%
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <button
                                    type="button"
                                    onClick={() => setViewingClientCardId(c.clientId)}
                                    className="font-semibold text-slate-900 hover:underline text-left"
                                    title="Открыть карточку заёмщика и список поручителей"
                                  >
                                    {c.clientName}
                                  </button>
                                  <div className="text-slate-500 mt-0.5">{c.itemTitle}</div>
                                </td>
                                <td className="py-3 px-4 font-mono text-right text-slate-700 whitespace-nowrap">
                                  {formatMoney(c.totalCostKopecks)}
                                </td>
                                <td className="py-3 px-4 font-mono text-right font-medium text-slate-900 whitespace-nowrap">
                                  {formatMoney(c.salePriceKopecks)}
                                </td>
                                <td className="py-3 px-4 font-mono text-right text-emerald-700 whitespace-nowrap">
                                  {formatMoney(c.totalCollectedKopecks)}
                                </td>
                                <td className="py-3 px-4 font-mono text-right font-semibold text-slate-900 whitespace-nowrap">
                                  {formatMoney(c.remainingDebtKopecks)}
                                  {c.overdueKopecks > 0 && (
                                    <div className="text-[11px] text-red-600 font-normal">
                                      Просрочено: {formatMoney(c.overdueKopecks)}
                                    </div>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-right">
                                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                                    {waDirectUrl && (
                                      <a
                                        href={waDirectUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-600 border border-emerald-700 rounded-lg hover:bg-emerald-700 inline-flex items-center gap-1 whitespace-nowrap"
                                        title={`Написать клиенту ${c.clientName} в WhatsApp`}
                                      >
                                        <MessageCircle className="w-3.5 h-3.5" />
                                        <span>Написать</span>
                                      </a>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setEarlyPayoffContract(c)}
                                      className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                                    >
                                      Досрочное
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setRestructureContract(c)}
                                      className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                                    >
                                      График (v{c.currentScheduleVersion})
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 2. КЛИЕНТЫ ==================== */}
              {activeSection === 'clients' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                      Реестр клиентов (рассрочников) и статусы
                    </h1>
                    <p className="text-xs text-slate-500 mt-1">
                      В таблице отображаются только клиенты-заёмщики. Если в течение{' '}
                      <strong className="text-slate-800">
                        {statusRules?.gracePeriodDays ?? 3} дн.
                      </strong>{' '}
                      после наступления даты платежа оплата не внесена, статус клиента автоматически меняется на{' '}
                      <strong className="text-amber-800">«Под наблюдением»</strong> (или{' '}
                      <strong className="text-red-800">«Сложный»</strong> при длительной просрочке). Нажмите на ФИО клиента или кнопку «Карточка», чтобы посмотреть его поручителей и договоры.
                    </p>
                  </div>

                  {canWrite && (
                    <form
                      onSubmit={handleCreateClient}
                      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <h2 className="text-sm font-semibold text-slate-900">
                        Добавить нового клиента
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <input
                          type="text"
                          value={clientForm.fullName}
                          onChange={(e) =>
                            setClientForm((p) => ({ ...p, fullName: e.target.value }))
                          }
                          placeholder="ФИО клиента полностью *"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="text"
                          value={clientForm.phone}
                          onChange={(e) => setClientForm((p) => ({ ...p, phone: e.target.value }))}
                          placeholder="Основной телефон *"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="text"
                          value={clientForm.secondaryPhone}
                          onChange={(e) =>
                            setClientForm((p) => ({ ...p, secondaryPhone: e.target.value }))
                          }
                          placeholder="Дополнительный телефон"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={clientForm.documentRef}
                          onChange={(e) =>
                            setClientForm((p) => ({ ...p, documentRef: e.target.value }))
                          }
                          placeholder="Отметка о документе (без лишних ПДн)"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={clientForm.address}
                          onChange={(e) =>
                            setClientForm((p) => ({ ...p, address: e.target.value }))
                          }
                          placeholder="Адрес доставки / проживания"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={clientForm.notes}
                          onChange={(e) => setClientForm((p) => ({ ...p, notes: e.target.value }))}
                          placeholder="Примечание"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="w-full sm:w-auto px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Сохранить карточку клиента
                        </button>
                      </div>
                    </form>
                  )}

                  {editingClient && canWrite && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await apiFetch(`/api/v1/clients/${editingClient.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                              fullName: editingClient.fullName,
                              phone: editingClient.phone,
                              secondaryPhone: editingClient.secondaryPhone,
                              documentRef: editingClient.documentRef,
                              address: editingClient.address,
                              notes: editingClient.notes,
                              status: editingClient.status,
                            }),
                          });
                          setEditingClient(null);
                          await loadFullState();
                          notify('success', 'Карточка клиента успешно обновлена.');
                        } catch (err) {
                          notify('error', err instanceof Error ? err.message : 'Ошибка обновления клиента');
                        }
                      }}
                      className="bg-white border border-slate-900 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 break-words">
                          Редактирование карточки клиента: {editingClient.fullName}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setEditingClient(null)}
                          className="text-xs text-slate-500 hover:text-slate-900 shrink-0"
                        >
                          Отмена
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <input
                          type="text"
                          value={editingClient.fullName}
                          onChange={(e) =>
                            setEditingClient((p) => (p ? { ...p, fullName: e.target.value } : null))
                          }
                          placeholder="ФИО клиента полностью *"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="text"
                          value={editingClient.phone}
                          onChange={(e) =>
                            setEditingClient((p) => (p ? { ...p, phone: e.target.value } : null))
                          }
                          placeholder="Основной телефон *"
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="text"
                          value={editingClient.secondaryPhone}
                          onChange={(e) =>
                            setEditingClient((p) =>
                              p ? { ...p, secondaryPhone: e.target.value } : null
                            )
                          }
                          placeholder="Дополнительный телефон"
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={editingClient.documentRef}
                          onChange={(e) =>
                            setEditingClient((p) => (p ? { ...p, documentRef: e.target.value } : null))
                          }
                          placeholder="Отметка о документе"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={editingClient.address}
                          onChange={(e) =>
                            setEditingClient((p) => (p ? { ...p, address: e.target.value } : null))
                          }
                          placeholder="Адрес доставки / проживания"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={editingClient.notes}
                          onChange={(e) =>
                            setEditingClient((p) => (p ? { ...p, notes: e.target.value } : null))
                          }
                          placeholder="Примечание"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <select
                          value={editingClient.status}
                          onChange={(e) =>
                            setEditingClient((p) =>
                              p ? { ...p, status: e.target.value as 'active' | 'archived' } : null
                            )
                          }
                          className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="active">Статус: Активен</option>
                          <option value="archived">Статус: В архиве</option>
                        </select>
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Сохранить изменения
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Filter & Sort Controls for Clients */}
                  <div className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            { id: 'all', label: 'Все заёмщики', count: borrowerClients.length },
                            {
                              id: 'vip',
                              label: 'VIP',
                              count: borrowerClients.filter((c) => c.paymentStatus === 'vip').length,
                            },
                            {
                              id: 'reliable',
                              label: 'Надёжный',
                              count: borrowerClients.filter((c) => c.paymentStatus === 'reliable').length,
                            },
                            {
                              id: 'watch',
                              label: 'Под наблюдением',
                              count: borrowerClients.filter((c) => c.paymentStatus === 'watch').length,
                            },
                            {
                              id: 'complex',
                              label: 'Сложный',
                              count: borrowerClients.filter((c) => c.paymentStatus === 'complex').length,
                            },
                            {
                              id: 'closed',
                              label: 'Рассрочка закрыта',
                              count: borrowerClients.filter((c) => c.paymentStatus === 'closed').length,
                            },
                            {
                              id: 'new',
                              label: 'Новый клиент',
                              count: borrowerClients.filter((c) => (c.paymentStatus || 'new') === 'new')
                                .length,
                            },
                          ] as Array<{ id: 'all' | ClientPaymentStatus; label: string; count: number }>
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setClientStatusFilter(tab.id)}
                            className={`px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                              clientStatusFilter === tab.id
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            {tab.label} ({tab.count})
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <label className="text-xs text-slate-500 whitespace-nowrap">Сортировка:</label>
                        <select
                          value={clientSortBy}
                          onChange={(e) => setClientSortBy(e.target.value as any)}
                          className="w-full sm:w-auto px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="status_severity">По статусу (проблемные сверху)</option>
                          <option value="debt_desc">По сумме остатка долга (убыв.)</option>
                          <option value="overdue_desc">По сумме просрочки (убыв.)</option>
                          <option value="name_asc">По ФИО (А–Я)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Clients List: Mobile/Tablet Cards + Desktop Scrollable Table */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    {/* Mobile & Tablet Cards (<1024px) */}
                    <div className="lg:hidden divide-y divide-slate-100">
                      {filteredClients.length === 0 ? (
                        <div className="p-8 text-center text-xs text-slate-500">
                          Клиенты по выбранному фильтру не найдены.
                        </div>
                      ) : (
                        filteredClients.map((cl) => {
                          const statusMeta = getClientPaymentStatusMeta(cl.paymentStatus);
                          const remainingDebt =
                            cl.totalRemainingDebtKopecks ?? (cl as any).totalDebtKopecks ?? 0;
                          const overdueDebt =
                            cl.totalOverdueKopecks ?? (cl as any).overdueDebtKopecks ?? 0;
                          return (
                            <div key={cl.id} className="p-4 space-y-3 text-xs">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => setViewingClientCardId(cl.id)}
                                    className="text-sm font-bold text-slate-900 hover:underline text-left break-words"
                                  >
                                    {cl.fullName}
                                  </button>
                                  <div className="font-mono text-slate-700 mt-0.5 break-words">
                                    {cl.phone}
                                    {cl.secondaryPhone ? ` · ${cl.secondaryPhone}` : ''}
                                  </div>
                                </div>
                                <span
                                  onClick={() => setViewingClientCardId(cl.id)}
                                  className={`px-2 py-0.5 text-[11px] font-medium border rounded-md inline-flex items-center gap-1 shrink-0 cursor-pointer ${statusMeta.badgeClass}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                                  <span>{statusMeta.label}</span>
                                </span>
                              </div>

                              <div className="text-[11px] text-slate-500 break-words">
                                {cl.paymentStatusReason || cl.address || 'Нажмите на ФИО клиента для просмотра карточки и поручителей'}
                              </div>

                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 bg-slate-50 rounded-lg font-mono text-[11px]">
                                <div>
                                  <div className="font-sans text-slate-500">Активных дог.</div>
                                  <div className="font-semibold text-slate-900">
                                    {cl.activeContractsCount ?? 0}
                                    {cl.completedContractsCount ? ` (закр.: ${cl.completedContractsCount})` : ''}
                                  </div>
                                </div>
                                <div>
                                  <div className="font-sans text-slate-500">Остаток долга</div>
                                  <div className="font-semibold text-slate-900">{formatMoney(remainingDebt)}</div>
                                </div>
                                <div>
                                  <div className="font-sans text-slate-500">Просрочка</div>
                                  <div className={overdueDebt > 0 ? 'text-red-600 font-semibold' : 'text-slate-600'}>
                                    {formatMoney(overdueDebt)}
                                  </div>
                                </div>
                                <div>
                                  <div className="font-sans text-slate-500">Ближ. платёж</div>
                                  <div className="text-slate-800">
                                    {cl.nextPaymentDate ? formatDateRu(cl.nextPaymentDate) : '—'}
                                  </div>
                                </div>
                              </div>

                              <div className="pt-0.5">
                                <QuickCallAndCopyBar
                                  phone={cl.phone}
                                  clientName={cl.fullName}
                                  onNotice={(msg) => notify('success', msg)}
                                  onError={(err) => notify('error', err)}
                                />
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
                                <button
                                  type="button"
                                  onClick={() => setViewingClientCardId(cl.id)}
                                  className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200"
                                >
                                  Карточка и поручители
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const firstCnt = contracts.find((c) => c.clientId === cl.id);
                                    setWhatsappTargetContractId(firstCnt?.id || null);
                                    setActiveSection('whatsapp_contracts');
                                  }}
                                  className="px-2.5 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 inline-flex items-center gap-1"
                                >
                                  <FileText className="w-3.5 h-3.5" />
                                  <span>Договор в WA</span>
                                </button>
                                {canWrite && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEditingClient({
                                        id: cl.id,
                                        fullName: cl.fullName,
                                        phone: cl.phone,
                                        secondaryPhone: cl.secondaryPhone || '',
                                        documentRef: cl.documentRef || '',
                                        address: cl.address || '',
                                        notes: cl.notes || '',
                                        status: cl.status,
                                      })
                                    }
                                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100"
                                  >
                                    Изменить
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Desktop Table (>=1024px) */}
                    <div className="hidden lg:block overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">ФИО заёмщика и статус</th>
                            <th className="py-3 px-4 font-medium">Телефон и быстрый звонок</th>
                            <th className="py-3 px-3 font-medium text-right">Договоров</th>
                            <th className="py-3 px-3 font-medium text-right">Остаток долга</th>
                            <th className="py-3 px-3 font-medium text-right">Просрочка</th>
                            <th className="py-3 px-3 font-medium text-right">Ближ. платёж</th>
                            <th className="py-3 px-4 font-medium text-right">Действия</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredClients.map((cl) => {
                            const statusMeta = getClientPaymentStatusMeta(cl.paymentStatus);
                            const remainingDebt =
                              cl.totalRemainingDebtKopecks ?? (cl as any).totalDebtKopecks ?? 0;
                            const overdueDebt =
                              cl.totalOverdueKopecks ?? (cl as any).overdueDebtKopecks ?? 0;
                            return (
                              <tr key={cl.id} className="hover:bg-slate-50/80 align-top">
                                <td className="py-3 px-4 max-w-[280px]">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setViewingClientCardId(cl.id)}
                                      className="font-semibold text-slate-900 hover:underline text-left break-words"
                                      title="Открыть карточку заёмщика и посмотреть поручителей"
                                    >
                                      {cl.fullName}
                                    </button>
                                    <span
                                      onClick={() => setViewingClientCardId(cl.id)}
                                      title={cl.paymentStatusReason || statusMeta.description}
                                      className={`px-2 py-0.5 text-[11px] font-medium border rounded-md inline-flex items-center gap-1 cursor-pointer ${statusMeta.badgeClass}`}
                                    >
                                      <span
                                        className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`}
                                      />
                                      <span>{statusMeta.label}</span>
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-500 mt-1 line-clamp-2 break-words">
                                    {cl.paymentStatusReason || cl.address || '—'}
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <div className="font-mono text-slate-800 mb-1.5 whitespace-nowrap">
                                    {cl.phone}
                                    {cl.secondaryPhone ? ` · ${cl.secondaryPhone}` : ''}
                                  </div>
                                  <QuickCallAndCopyBar
                                    phone={cl.phone}
                                    clientName={cl.fullName}
                                    onNotice={(msg) => notify('success', msg)}
                                    onError={(err) => notify('error', err)}
                                  />
                                </td>
                                <td className="py-3 px-3 font-mono text-right whitespace-nowrap">
                                  {cl.activeContractsCount ?? 0}
                                  {cl.completedContractsCount ? (
                                    <div className="text-[10px] text-slate-400">
                                      закр.: {cl.completedContractsCount}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="py-3 px-3 font-mono text-right font-semibold text-slate-900 whitespace-nowrap">
                                  {formatMoney(remainingDebt)}
                                </td>
                                <td
                                  className={`py-3 px-3 font-mono text-right font-medium whitespace-nowrap ${
                                    overdueDebt > 0 ? 'text-red-600' : 'text-slate-500'
                                  }`}
                                >
                                  {formatMoney(overdueDebt)}
                                </td>
                                <td className="py-3 px-3 font-mono text-right text-slate-700 whitespace-nowrap">
                                  {cl.nextPaymentDate ? formatDateRu(cl.nextPaymentDate) : '—'}
                                </td>
                                <td className="py-3 px-4 text-right">
                                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                                    <button
                                      type="button"
                                      onClick={() => setViewingClientCardId(cl.id)}
                                      className="px-2.5 py-1 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 whitespace-nowrap"
                                    >
                                      Карточка / Поручители
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const firstCnt = contracts.find((c) => c.clientId === cl.id);
                                        setWhatsappTargetContractId(firstCnt?.id || null);
                                        setActiveSection('whatsapp_contracts');
                                      }}
                                      className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 inline-flex items-center gap-1 whitespace-nowrap"
                                      title="Найти договор и отправить скан в WhatsApp"
                                    >
                                      <FileText className="w-3.5 h-3.5" />
                                      <span>Договор в WA</span>
                                    </button>
                                    {canWrite && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setEditingClient({
                                            id: cl.id,
                                            fullName: cl.fullName,
                                            phone: cl.phone,
                                            secondaryPhone: cl.secondaryPhone || '',
                                            documentRef: cl.documentRef || '',
                                            address: cl.address || '',
                                            notes: cl.notes || '',
                                            status: cl.status,
                                          })
                                        }
                                        className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                                      >
                                        Изменить
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== НАЙТИ И ОТПРАВИТЬ ДОГОВОР (WHATSAPP & CALLS) ==================== */}
              {activeSection === 'whatsapp_contracts' && (
                <FindAndSendContractSection
                  clients={clients}
                  contracts={contracts}
                  documents={documents}
                  initialSelectedContractId={whatsappTargetContractId}
                  apiFetch={apiFetch}
                  onRefresh={loadFullState}
                  onOpenClientCard={(cl) => setViewingClientCardId(cl.id)}
                  fetchProtectedBlob={fetchProtectedBlob}
                  downloadProtectedFile={downloadProtectedFile}
                />
              )}

              {/* ==================== 3. ДОГОВОРЫ И ГРАФИКИ ==================== */}
              {activeSection === 'contracts' && (
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                        Договоры продажи в рассрочку и графики платежей
                      </h1>
                      <p className="text-xs text-slate-500 mt-1">
                        Нажмите на ФИО заёмщика или кнопку «Поручители и карточка», чтобы открыть данные заёмщика и его поручителей.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveSection('whatsapp_contracts')}
                        className="px-3.5 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 inline-flex items-center gap-1.5"
                      >
                        <MessageCircle className="w-4 h-4" />
                        <span>Найти и отправить договор в WhatsApp</span>
                      </button>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() => setShowNewContractModal(true)}
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5"
                        >
                          <Plus className="w-4 h-4" />
                          <span>Оформить новый договор</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {filteredContracts.map((c) => {
                      const cStatusMeta = getClientPaymentStatusMeta(c.contractStatus);
                      const contractDocs = documents.filter(
                        (d) =>
                          (d.contractId === c.id ||
                            (d.entityType === 'contract' && d.entityId === c.id)) &&
                          !d.isArchived
                      );
                      const attachedFilesCount = contractDocs.length;
                      const guarantorsCount = c.guarantors?.length || 0;
                      return (
                        <div key={c.id} className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
                          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 border-b border-slate-200 pb-4">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-mono font-bold text-slate-900">
                                  {c.contractNumber}
                                </span>
                                <span className="text-slate-400">·</span>
                                <button
                                  type="button"
                                  onClick={() => setViewingClientCardId(c.clientId)}
                                  className="font-semibold text-slate-900 hover:underline text-left break-words"
                                  title="Нажмите, чтобы открыть карточку заёмщика и его поручителей"
                                >
                                  {c.clientName}
                                </button>
                                <span
                                  className={`px-2 py-0.5 text-[11px] font-medium border rounded-md inline-flex items-center gap-1 ${cStatusMeta.badgeClass}`}
                                  title={c.contractStatusReason}
                                >
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${cStatusMeta.dotClass}`}
                                  />
                                  <span>{cStatusMeta.label}</span>
                                </span>
                                <span className="text-slate-400">·</span>
                                <span className="text-xs text-slate-600">
                                  {translateContractStatus(c.status)}
                                </span>
                              </div>
                              <div className="text-xs text-slate-600 mt-1 break-words">
                                Товар: <strong>{c.itemTitle}</strong> · Оформлен:{' '}
                                <span className="font-mono">{formatDateRu(c.startDate)}</span> · Срок:{' '}
                                <span className="font-mono">{c.termMonths} мес.</span> · Версия графика:{' '}
                                <span className="font-mono">v{c.currentScheduleVersion}</span> · Прикреплено файлов:{' '}
                                <span className="font-mono font-semibold">{attachedFilesCount}</span>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setViewingClientCardId(c.clientId)}
                                className="px-3 py-1.5 text-xs font-medium text-indigo-900 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 inline-flex items-center gap-1.5"
                              >
                                <span>Карточка и поручители ({guarantorsCount})</span>
                              </button>
                              {buildDirectWhatsAppUrl(c.clientPhone) && (
                                <a
                                  href={buildDirectWhatsAppUrl(c.clientPhone)!}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 border border-emerald-700 rounded-lg hover:bg-emerald-700 inline-flex items-center gap-1.5"
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                  <span>Написать в WhatsApp</span>
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setWhatsappTargetContractId(c.id);
                                  setActiveSection('whatsapp_contracts');
                                }}
                                className="px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 inline-flex items-center gap-1.5"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>Отправить договор / Скан ({attachedFilesCount})</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setEarlyPayoffContract(c)}
                                className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                              >
                                <Calculator className="w-3.5 h-3.5" />
                                <span>Досрочное погашение</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setRestructureContract(c)}
                                className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                              >
                                <History className="w-3.5 h-3.5" />
                                <span>История графика (v{c.currentScheduleVersion})</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setPrintTemplateModal({ contract: c, type: 'contract' })}
                                className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                              >
                                <Printer className="w-3.5 h-3.5" />
                                <span>Печать договора</span>
                              </button>
                            </div>
                          </div>

                        {/* Attached Photos / Scans of this Contract */}
                        {contractDocs.length > 0 && (
                          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                            <div className="text-[11px] font-medium text-slate-700">
                              Прикреплённые фото и сканы договора ({contractDocs.length}):
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {contractDocs.map((doc) => (
                                <div
                                  key={doc.id}
                                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs flex flex-wrap items-center gap-2 max-w-full"
                                >
                                  <FileText className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                                  <span
                                    className="font-medium text-slate-900 truncate max-w-[160px] sm:max-w-[220px]"
                                    title={doc.originalFilename}
                                  >
                                    {doc.originalFilename}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setPreviewingDocument(doc)}
                                    className="px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 inline-flex items-center gap-1"
                                  >
                                    <Eye className="w-3 h-3" />
                                    <span>Просмотр</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await downloadProtectedFile(
                                          `/api/v1/documents/${doc.id}/download`,
                                          doc.originalFilename || `${doc.id}.bin`
                                        );
                                      } catch (err) {
                                        notify(
                                          'error',
                                          err instanceof Error
                                            ? err.message
                                            : 'Ошибка скачивания файла'
                                        );
                                      }
                                    }}
                                    className="px-2 py-0.5 text-[11px] font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-100 inline-flex items-center gap-1"
                                  >
                                    <Download className="w-3 h-3" />
                                    <span>Скачать</span>
                                  </button>
                                  {isOwner &&
                                    (confirmDeleteContractDocId === doc.id ? (
                                      <span className="inline-flex items-center gap-1 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                                        <button
                                          type="button"
                                          onClick={async () => {
                                            try {
                                              await apiFetch(`/api/v1/documents/${doc.id}`, {
                                                method: 'DELETE',
                                              });
                                              setConfirmDeleteContractDocId(null);
                                              await loadFullState();
                                              notify(
                                                'success',
                                                `Прикреплённое фото/файл «${doc.originalFilename}» удалено.`
                                              );
                                            } catch (err) {
                                              notify(
                                                'error',
                                                err instanceof Error
                                                  ? err.message
                                                  : 'Ошибка удаления файла'
                                              );
                                            }
                                          }}
                                          className="text-[11px] font-semibold text-red-700 hover:underline"
                                        >
                                          Да, удалить
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmDeleteContractDocId(null)}
                                          className="text-[11px] text-slate-600 hover:text-slate-900 ml-1"
                                        >
                                          Отмена
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteContractDocId(doc.id)}
                                        className="px-2 py-0.5 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 inline-flex items-center gap-1"
                                        title="Удалить прикреплённое фото / файл"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                        <span>Удалить</span>
                                      </button>
                                    ))}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Contract Financial Breakdown */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                          <div>
                            <div className="font-sans text-slate-500">Полная себестоимость</div>
                            <div className="font-semibold text-slate-900 mt-0.5 break-words">
                              {formatMoney(c.totalCostKopecks)}
                            </div>
                          </div>
                          <div>
                            <div className="font-sans text-slate-500">
                              Наценка ({c.markupPercent}%)
                            </div>
                            <div className="font-semibold text-emerald-700 mt-0.5 break-words">
                              +{formatMoney(c.markupKopecks)}
                            </div>
                          </div>
                          <div>
                            <div className="font-sans text-slate-500">Цена продажи</div>
                            <div className="font-semibold text-slate-900 mt-0.5 break-words">
                              {formatMoney(c.salePriceKopecks)}
                            </div>
                          </div>
                          <div>
                            <div className="font-sans text-slate-500">
                              1-й взнос ({c.downPaymentPercent}%)
                            </div>
                            <div className="font-semibold text-slate-900 mt-0.5 break-words">
                              {formatMoney(c.downPaymentKopecks)}
                            </div>
                          </div>
                          <div>
                            <div className="font-sans text-slate-500">Фактически оплачено</div>
                            <div className="font-semibold text-emerald-700 mt-0.5 break-words">
                              {formatMoney(c.totalCollectedKopecks)}
                            </div>
                          </div>
                          <div>
                            <div className="font-sans text-slate-500">Текущий остаток долга</div>
                            <div className="font-bold text-slate-900 mt-0.5 break-words">
                              {formatMoney(c.remainingDebtKopecks)}
                            </div>
                          </div>
                        </div>

                        {/* Active Schedule Table */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs min-w-[540px]">
                            <thead>
                              <tr className="border-b border-slate-200 text-slate-500">
                                <th className="py-2 pr-3 font-medium">Платёж</th>
                                <th className="py-2 pr-3 font-medium">Дата по графику</th>
                                <th className="py-2 pr-3 font-medium text-right">Сумма по плану</th>
                                <th className="py-2 pr-3 font-medium text-right">Внесено</th>
                                <th className="py-2 pr-3 font-medium text-right">Остаток по строке</th>
                                <th className="py-2 font-medium">Статус и примечание</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {c.schedule.map((item) => (
                                <tr key={item.id}>
                                  <td className="py-2 pr-3 font-mono font-medium whitespace-nowrap">
                                    №{item.installmentNumber}
                                  </td>
                                  <td className="py-2 pr-3 font-mono whitespace-nowrap">{formatDateRu(item.dueDate)}</td>
                                  <td className="py-2 pr-3 font-mono text-right whitespace-nowrap">
                                    {formatMoney(item.plannedKopecks)}
                                  </td>
                                  <td className="py-2 pr-3 font-mono text-right text-emerald-700 whitespace-nowrap">
                                    {formatMoney(item.paidKopecks)}
                                  </td>
                                  <td className="py-2 pr-3 font-mono text-right font-semibold whitespace-nowrap">
                                    {formatMoney(item.remainingKopecks)}
                                  </td>
                                  <td className="py-2 text-slate-700">
                                    <span
                                      className={
                                        item.daysOverdue > 0
                                          ? 'text-red-600 font-medium'
                                          : item.status === 'paid'
                                            ? 'text-emerald-700'
                                            : 'text-slate-700'
                                      }
                                    >
                                      {translateScheduleStatus(item.status)}
                                    </span>
                                    {item.daysOverdue > 0 && (
                                      <span className="text-red-600 ml-1.5 font-mono">
                                        ({item.daysOverdue} дн. задержки)
                                      </span>
                                    )}
                                    {item.promisedDate && (
                                      <span className="text-slate-500 ml-1.5">
                                        · Обещано до {formatDateRu(item.promisedDate)}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ==================== 4. ПЛАТЕЖИ И РАСПРЕДЕЛЕНИЕ ==================== */}
              {activeSection === 'payments' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                        Платежи клиентов и распределение (авто и ручное)
                      </h1>
                      <p className="text-xs text-slate-500 mt-1 break-words">
                        По умолчанию закрывает текущий месяц, а сумму сверху равномерно распределяет на все оставшиеся месяцы (также доступен режим по очереди по месяцам и ручной ввод).
                      </p>
                    </div>
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => setShowNewPaymentModal(true)}
                        className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center gap-1.5 shrink-0"
                      >
                        <Plus className="w-4 h-4 shrink-0" />
                        <span>Зарегистрировать поступление</span>
                      </button>
                    )}
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards View */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {filteredPayments.map((p) => (
                        <div
                          key={p.id}
                          className={`p-4 space-y-3 ${p.status === 'reversed' ? 'opacity-50 bg-slate-50/60' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <button
                                type="button"
                                onClick={() => setViewingClientCardId(p.clientId)}
                                className="font-semibold text-sm text-slate-900 hover:underline text-left break-words"
                              >
                                {p.clientName}
                              </button>
                              <div className="text-xs text-slate-500 mt-0.5 break-words">
                                {p.contractNumber ? `Договор ${p.contractNumber}` : 'Без договора (ожидает выбора)'}{' '}
                                · {p.accountName}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono text-sm font-bold text-slate-900">
                                {formatMoney(p.amountKopecks)}
                              </div>
                              <div className="font-mono text-[11px] text-slate-500">
                                {formatDateRu(p.eventDate)}
                              </div>
                            </div>
                          </div>

                          {p.notes && (
                            <div className="text-xs text-slate-600 break-words">{p.notes}</div>
                          )}

                          <div className="grid grid-cols-2 gap-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 text-xs">
                            <div>
                              <div className="text-[11px] text-slate-500">Распределено</div>
                              <div className="font-mono font-semibold text-emerald-700 mt-0.5">
                                {formatMoney(p.allocatedKopecks)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-slate-500">Не распределено</div>
                              <div
                                className={`font-mono font-semibold mt-0.5 ${
                                  p.unallocatedKopecks > 0 ? 'text-amber-700' : 'text-slate-400'
                                }`}
                              >
                                {formatMoney(p.unallocatedKopecks)}
                              </div>
                            </div>
                          </div>

                          {p.allocations.length > 0 && (
                            <div className="text-[11px] text-slate-500 font-mono break-words">
                              Распределено на:{' '}
                              {p.allocations
                                .map((a) => `№${a.installmentNumber} (${formatMoney(a.amountKopecks)})`)
                                .join(', ')}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            {p.status === 'confirmed' && p.unallocatedKopecks > 0 && canWrite && (
                              <button
                                type="button"
                                onClick={() => setAllocatingPayment(p)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap flex items-center gap-1.5"
                              >
                                <span>Распределить</span>
                              </button>
                            )}
                            {p.status === 'confirmed' && !p.isDownPayment && isOwner && (
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/v1/payments/${p.id}/reverse`, {
                                      method: 'POST',
                                      body: JSON.stringify({
                                        reason: 'Корректирующее сторно платежа по решению владельца',
                                      }),
                                    });
                                    await loadFullState();
                                    notify(
                                      'success',
                                      'Платёж сторнирован с сохранением записи в истории и возвратом сумм в графике.'
                                    );
                                  } catch (err) {
                                    notify(
                                      'error',
                                      err instanceof Error ? err.message : 'Ошибка сторнирования'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1 whitespace-nowrap"
                              >
                                <RotateCcw className="w-3 h-3 shrink-0" />
                                <span>Сторно</span>
                              </button>
                            )}
                            {p.status === 'reversed' && (
                              <span className="text-xs text-red-600 break-words">
                                Сторнирован ({p.reversalReason})
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {filteredPayments.length === 0 && (
                        <div className="p-8 text-center text-xs text-slate-500">
                          Нет зарегистрированных платежей по заданному фильтру.
                        </div>
                      )}
                    </div>

                    {/* Desktop Table View */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[780px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Дата и ID операции</th>
                            <th className="py-3 px-4 font-medium">Клиент и договор</th>
                            <th className="py-3 px-4 font-medium">Касса / Счёт</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Сумма поступления</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Распределено</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Не распределено</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Действия</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredPayments.map((p) => (
                            <tr
                              key={p.id}
                              className={`hover:bg-slate-50/80 ${
                                p.status === 'reversed' ? 'opacity-50' : ''
                              }`}
                            >
                              <td className="py-3 px-4 whitespace-nowrap">
                                <div className="font-mono font-medium text-slate-900">
                                  {formatDateRu(p.eventDate)}
                                </div>
                                <div className="font-mono text-[11px] text-slate-400">{p.id}</div>
                              </td>
                              <td className="py-3 px-4">
                                <button
                                  type="button"
                                  onClick={() => setViewingClientCardId(p.clientId)}
                                  className="font-semibold text-slate-900 hover:underline text-left"
                                >
                                  {p.clientName}
                                </button>
                                <div className="text-slate-500 mt-0.5 break-words">
                                  {p.contractNumber ? `Договор ${p.contractNumber}` : 'Без договора (ожидает выбора)'}{' '}
                                  · {p.notes}
                                </div>
                                {p.allocations.length > 0 && (
                                  <div className="text-[11px] text-slate-500 mt-1 font-mono break-words">
                                    Распределено на:{' '}
                                    {p.allocations
                                      .map(
                                        (a) =>
                                          `№${a.installmentNumber} (${formatMoney(a.amountKopecks)})`
                                      )
                                      .join(', ')}
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-4 text-slate-700">{p.accountName}</td>
                              <td className="py-3 px-4 font-mono text-right font-semibold text-slate-900 whitespace-nowrap">
                                {formatMoney(p.amountKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right text-emerald-700 whitespace-nowrap">
                                {formatMoney(p.allocatedKopecks)}
                              </td>
                              <td
                                className={`py-3 px-4 font-mono text-right font-semibold whitespace-nowrap ${
                                  p.unallocatedKopecks > 0 ? 'text-amber-700' : 'text-slate-400'
                                }`}
                              >
                                {formatMoney(p.unallocatedKopecks)}
                              </td>
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                <div className="flex items-center justify-end gap-2">
                                  {p.status === 'confirmed' && p.unallocatedKopecks > 0 && canWrite && (
                                    <button
                                      type="button"
                                      onClick={() => setAllocatingPayment(p)}
                                      className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap flex items-center gap-1.5"
                                    >
                                      <span>Распределить</span>
                                    </button>
                                  )}
                                  {p.status === 'confirmed' && !p.isDownPayment && isOwner && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        try {
                                          await apiFetch(`/api/v1/payments/${p.id}/reverse`, {
                                            method: 'POST',
                                            body: JSON.stringify({
                                              reason:
                                                'Корректирующее сторно платежа по решению владельца',
                                            }),
                                          });
                                          await loadFullState();
                                          notify(
                                            'success',
                                            'Платёж сторнирован с сохранением записи в истории и возвратом сумм в графике.'
                                          );
                                        } catch (err) {
                                          notify(
                                            'error',
                                            err instanceof Error ? err.message : 'Ошибка сторнирования'
                                          );
                                        }
                                      }}
                                      className="px-2.5 py-1.5 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1 whitespace-nowrap"
                                    >
                                      <RotateCcw className="w-3 h-3 shrink-0" />
                                      <span>Сторно</span>
                                    </button>
                                  )}
                                  {p.status === 'reversed' && (
                                    <span className="text-xs text-red-600">
                                      Сторнирован ({p.reversalReason})
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                          {filteredPayments.length === 0 && (
                            <tr>
                              <td colSpan={7} className="py-8 text-center text-slate-500">
                                Нет зарегистрированных платежей по заданному фильтру.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 5. ПРОСРОЧКИ ==================== */}
              {activeSection === 'overdues' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Контроль просроченных платежей
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Автоматические штрафы и пени не начисляются. Фиксируйте результаты контактов с клиентом, обещанную дату оплаты или согласованный перенос срока.
                    </p>
                  </div>

                  {overdueContactForm && (
                    <form
                      onSubmit={handleSaveOverdueContact}
                      className="bg-white border border-slate-900 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 break-words">
                          Зафиксировать контакт с клиентом / обещанную дату оплаты
                        </h3>
                        <button
                          type="button"
                          onClick={() => setOverdueContactForm(null)}
                          className="text-xs text-slate-500 hover:text-slate-900 shrink-0"
                        >
                          Закрыть
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Канал связи
                          </label>
                          <select
                            value={overdueContactForm.contactChannel}
                            onChange={(e) =>
                              setOverdueContactForm((p) =>
                                p ? { ...p, contactChannel: e.target.value as any } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="phone">Телефонный звонок</option>
                            <option value="messenger">Сообщение в мессенджере</option>
                            <option value="in_person">Личная встреча</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Обещанная клиентом дата оплаты
                          </label>
                          <input
                            type="date"
                            value={overdueContactForm.promisedDate}
                            onChange={(e) =>
                              setOverdueContactForm((p) =>
                                p ? { ...p, promisedDate: e.target.value } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Согласованный перенос даты в графике (если утверждён)
                          </label>
                          <input
                            type="date"
                            value={overdueContactForm.agreedNewDueDate}
                            onChange={(e) =>
                              setOverdueContactForm((p) =>
                                p ? { ...p, agreedNewDueDate: e.target.value } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Результат договорённости с клиентом *
                          </label>
                          <input
                            type="text"
                            value={overdueContactForm.summary}
                            onChange={(e) =>
                              setOverdueContactForm((p) =>
                                p ? { ...p, summary: e.target.value } : null
                              )
                            }
                            placeholder="Например: Клиент предупредил о задержке зарплаты, обязуется внести остаток 31.10.2026"
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                            required
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Сохранить в журнал просрочек
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="space-y-4">
                    {overdues.map((o) => {
                      const overdueContract = contracts.find((c) => c.id === o.contractId);
                      return (
                        <div
                          key={o.scheduleItemId}
                          className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                            <div className="space-y-1.5 min-w-0">
                              <div className="text-sm font-semibold text-slate-900 break-words">
                                {overdueContract ? (
                                  <button
                                    type="button"
                                    onClick={() => setViewingClientCardId(overdueContract.clientId)}
                                    className="hover:underline text-left font-bold"
                                  >
                                    {o.clientName}
                                  </button>
                                ) : (
                                  <span>{o.clientName}</span>
                                )}{' '}
                                · <span className="font-mono">{o.clientPhone}</span>
                              </div>
                              <div className="text-xs text-slate-600 break-words">
                                Договор <span className="font-mono font-medium">{o.contractNumber}</span>{' '}
                                · Товар: {o.itemTitle} · Платёж №{o.installmentNumber} от{' '}
                                <span className="font-mono">{formatDateRu(o.dueDate)}</span>
                              </div>
                              <div className="pt-0.5 flex flex-wrap items-center gap-2">
                                <QuickCallAndCopyBar
                                  phone={o.clientPhone}
                                  clientName={o.clientName}
                                  onNotice={(msg) => notify('success', msg)}
                                  onError={(err) => notify('error', err)}
                                />
                                {overdueContract && (
                                  <button
                                    type="button"
                                    onClick={() => setViewingClientCardId(overdueContract.clientId)}
                                    className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200"
                                  >
                                    Карточка и поручители ({overdueContract.guarantors.length})
                                  </button>
                                )}
                              </div>
                            </div>

                            <div className="sm:text-right shrink-0">
                              <div className="text-xs text-slate-500">
                                Просрочка: <strong className="text-red-600">{o.daysOverdue} дн.</strong>
                              </div>
                              <div className="text-base font-bold font-mono text-red-600">
                                {formatMoney(o.overdueKopecks)}
                              </div>
                              {o.promisedDate && (
                                <div className="text-xs text-slate-600">
                                  Обещанная дата: <span className="font-mono">{formatDateRu(o.promisedDate)}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {o.contacts.length > 0 && (
                            <div className="pt-2 border-t border-slate-100 space-y-1.5 text-xs">
                              <div className="font-medium text-slate-700">История контактов:</div>
                              {o.contacts.map((ct) => (
                                <div key={ct.id} className="text-slate-600 break-words">
                                  <span className="font-mono text-slate-500">
                                    {formatDateTimeRu(ct.createdAt)}
                                  </span>{' '}
                                  · {ct.summary}
                                  {ct.promisedDate ? ` (обещано к ${formatDateRu(ct.promisedDate)})` : ''}
                                </div>
                              ))}
                            </div>
                          )}

                          {canWrite && (
                            <div className="pt-2 flex justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  setOverdueContactForm({
                                    scheduleItemId: o.scheduleItemId,
                                    contractId: o.contractId,
                                    contactChannel: 'phone',
                                    summary: '',
                                    promisedDate: o.promisedDate || '',
                                    agreedNewDueDate: '',
                                  })
                                }
                                className="px-3 py-1.5 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                              >
                                Зафиксировать звонок / перенос даты
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {overdues.length === 0 && (
                      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
                        Просроченных платежей не обнаружено. Все клиенты платят по графику.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ==================== 6. ЗАКУПКИ И ТОВАРЫ ==================== */}
              {activeSection === 'purchases' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Целевые закупки товаров под клиентов
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Полная себестоимость = Цена покупки в магазине + Доставка + Прочие прямые затраты.
                    </p>
                  </div>

                  {canWrite && (
                    <form
                      onSubmit={handleCreatePurchase}
                      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <h2 className="text-sm font-semibold text-slate-900">
                        Зарегистрировать новую покупку товара
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <select
                          value={purchaseForm.supplierId}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, supplierId: e.target.value }))
                          }
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>
                              Магазин: {s.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={purchaseForm.clientId}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, clientId: e.target.value }))
                          }
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="">— Под клиента (опционально) —</option>
                          {borrowerClients.map((cl) => (
                            <option key={cl.id} value={cl.id}>
                              {cl.fullName}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={purchaseForm.itemName}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, itemName: e.target.value }))
                          }
                          placeholder="Наименование товара *"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="1"
                          value={purchaseForm.purchaseRubles}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, purchaseRubles: e.target.value }))
                          }
                          placeholder="Цена покупки в магазине (₽) *"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={purchaseForm.deliveryRubles}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, deliveryRubles: e.target.value }))
                          }
                          placeholder="Стоимость доставки (₽)"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={purchaseForm.paidSupplierRubles}
                          onChange={(e) =>
                            setPurchaseForm((p) => ({ ...p, paidSupplierRubles: e.target.value }))
                          }
                          placeholder="Оплачено поставщику сразу (₽)"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Сохранить закупку и провести оплату
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {purchases.map((p) => (
                        <div key={p.id} className="p-4 space-y-2.5 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-sm text-slate-900 break-words">
                                {p.itemName}
                              </div>
                              <div className="text-slate-500 mt-0.5 break-words">
                                {formatDateRu(p.purchaseDate)} ·{' '}
                                {p.contractNumber ? `Договор ${p.contractNumber}` : 'Свободен к оформлению'}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              {p.supplierDebtKopecks > 0 ? (
                                <span className="inline-flex px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-mono font-semibold text-[11px]">
                                  Долг: {formatMoney(p.supplierDebtKopecks)}
                                </span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium text-[11px]">
                                  Оплачено
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-slate-700 break-words">
                            Магазин: <span className="font-medium">{p.supplierName}</span>
                            {p.clientName ? ` · Клиент: ${p.clientName}` : ''}
                          </div>
                          <div className="grid grid-cols-3 gap-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
                            <div>
                              <div className="text-[10px] text-slate-500">Закупка</div>
                              <div className="font-mono font-medium text-slate-900 mt-0.5">
                                {formatMoney(p.purchasePriceKopecks)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-500">Доставка</div>
                              <div className="font-mono font-medium text-slate-900 mt-0.5">
                                {formatMoney(p.deliveryCostKopecks + p.otherCostKopecks)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-500">Себестоимость</div>
                              <div className="font-mono font-semibold text-slate-900 mt-0.5">
                                {formatMoney(p.totalCostKopecks)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">Дата и товар</th>
                            <th className="py-3 px-4 font-medium">Магазин / Клиент</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Цена покупки</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Доставка</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Полная себестоимость</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Долг поставщику</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {purchases.map((p) => (
                            <tr key={p.id} className="hover:bg-slate-50/80">
                              <td className="py-3 px-4">
                                <div className="font-semibold text-slate-900 break-words">{p.itemName}</div>
                                <div className="text-slate-500 mt-0.5">
                                  {formatDateRu(p.purchaseDate)} ·{' '}
                                  {p.contractNumber ? `Договор ${p.contractNumber}` : 'Свободен к оформлению'}
                                </div>
                              </td>
                              <td className="py-3 px-4">
                                <div className="text-slate-900 break-words">{p.supplierName}</div>
                                <div className="text-slate-500 mt-0.5 break-words">{p.clientName || '—'}</div>
                              </td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">
                                {formatMoney(p.purchasePriceKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">
                                {formatMoney(p.deliveryCostKopecks + p.otherCostKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right font-semibold text-slate-900 whitespace-nowrap">
                                {formatMoney(p.totalCostKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">
                                {p.supplierDebtKopecks > 0 ? (
                                  <span className="text-amber-700 font-semibold">
                                    {formatMoney(p.supplierDebtKopecks)}
                                  </span>
                                ) : (
                                  <span className="text-emerald-700">Оплачено</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 7. МАГАЗИНЫ И ПОСТАВЩИКИ ==================== */}
              {activeSection === 'suppliers' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Магазины и поставщики
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Учёт магазинов приобретения товаров, объёмов закупок и текущих обязательств перед поставщиками.
                    </p>
                  </div>

                  {canWrite && (
                    <form
                      onSubmit={handleCreateSupplier}
                      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <h2 className="text-sm font-semibold text-slate-900">
                        Добавить магазин или поставщика
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <input
                          type="text"
                          value={supplierForm.name}
                          onChange={(e) => setSupplierForm((p) => ({ ...p, name: e.target.value }))}
                          placeholder="Название магазина / поставщика *"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="text"
                          value={supplierForm.category}
                          onChange={(e) =>
                            setSupplierForm((p) => ({ ...p, category: e.target.value }))
                          }
                          placeholder="Направление (Электроника, Мебель, Автотовары)"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="text"
                          value={supplierForm.contactInfo}
                          onChange={(e) =>
                            setSupplierForm((p) => ({ ...p, contactInfo: e.target.value }))
                          }
                          placeholder="Контакты и адрес магазина"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Добавить в справочник
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {suppliers.map((s) => (
                        <div key={s.id} className="p-4 space-y-2.5 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-sm text-slate-900 break-words">{s.name}</div>
                              <div className="text-slate-500 mt-0.5 break-words">{s.category}</div>
                            </div>
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px] shrink-0">
                              Закупок: {s.purchasesCount}
                            </span>
                          </div>
                          {s.contactInfo && (
                            <div className="text-slate-600 break-words">{s.contactInfo}</div>
                          )}
                          <div className="grid grid-cols-3 gap-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
                            <div>
                              <div className="text-[10px] text-slate-500">Объём закупок</div>
                              <div className="font-mono font-medium text-slate-900 mt-0.5">
                                {formatMoney(s.totalPurchasedKopecks)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-500">Оплачено</div>
                              <div className="font-mono font-medium text-emerald-700 mt-0.5">
                                {formatMoney(s.totalPaidKopecks)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-500">Наш долг</div>
                              <div className="font-mono font-semibold text-amber-700 mt-0.5">
                                {formatMoney(s.totalDebtKopecks)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[680px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">Магазин / Поставщик</th>
                            <th className="py-3 px-4 font-medium">Контакты</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Закупок</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Объём закупок</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Оплачено</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Наш долг поставщику</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {suppliers.map((s) => (
                            <tr key={s.id} className="hover:bg-slate-50/80">
                              <td className="py-3 px-4">
                                <div className="font-semibold text-slate-900 break-words">{s.name}</div>
                                <div className="text-slate-500 mt-0.5 break-words">{s.category}</div>
                              </td>
                              <td className="py-3 px-4 text-slate-600 break-words">{s.contactInfo || '—'}</td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">{s.purchasesCount}</td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">
                                {formatMoney(s.totalPurchasedKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right text-emerald-700 whitespace-nowrap">
                                {formatMoney(s.totalPaidKopecks)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right font-semibold text-amber-700 whitespace-nowrap">
                                {formatMoney(s.totalDebtKopecks)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 8. КАССА И БАНКОВСКИЕ СЧЕТА & 9. РАСХОДЫ ==================== */}
              {(activeSection === 'cash_bank' || activeSection === 'expenses') && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      {activeSection === 'cash_bank'
                        ? 'Касса, банковские счета и движение денежных средств'
                        : 'Операционные расходы бизнеса'}
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Подтверждённые денежные операции не удаляются бесследно. Пополнения собственными средствами и внутренние переводы не искажают выручку.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {accounts.map((acc) => (
                      <div key={acc.id} className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                        <div className="text-xs text-slate-500">
                          {acc.accountType === 'cash' ? 'Наличная касса' : 'Банковский счёт'}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 mt-0.5 break-words">{acc.name}</div>
                        <div className="text-xl sm:text-2xl font-bold font-mono text-slate-900 mt-2 break-words">
                          {formatMoney(acc.balanceKopecks)}
                        </div>
                      </div>
                    ))}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                      <div className="text-xs text-slate-500">Статус сверки регистров</div>
                      <div className="text-sm font-semibold text-emerald-700 mt-1 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span className="break-words">
                          {reconciliation?.isHealthy
                            ? 'Балансы счетов = сумме проводок'
                            : 'Обнаружено расхождение'}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-2 break-words">
                        Сальдо: {formatMoney(reconciliation?.calculatedLedgerBalanceKopecks || 0)}
                      </div>
                    </div>
                  </div>

                  {canWrite && (
                    <form
                      onSubmit={handleRecordLedgerOperation}
                      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <h2 className="text-sm font-semibold text-slate-900">
                        Провести операцию по кассе или банковскому счёту
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Тип операции
                          </label>
                          <select
                            value={ledgerForm.entryType}
                            onChange={(e) =>
                              setLedgerForm((p) => ({ ...p, entryType: e.target.value as any }))
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="operating_expense">Операционный расход бизнеса</option>
                            <option value="internal_transfer">
                              Внутренний перевод между своими счетами
                            </option>
                            {isOwner && (
                              <>
                                <option value="owner_injection">
                                  Пополнение собственными средствами владельца (не выручка)
                                </option>
                                <option value="owner_withdrawal">
                                  Личное изъятие средств владельцем
                                </option>
                              </>
                            )}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Счёт операции
                          </label>
                          <select
                            value={ledgerForm.accountId}
                            onChange={(e) =>
                              setLedgerForm((p) => ({ ...p, accountId: e.target.value }))
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        {ledgerForm.entryType === 'internal_transfer' ? (
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Счёт зачисления перевода
                            </label>
                            <select
                              value={ledgerForm.targetAccountId}
                              onChange={(e) =>
                                setLedgerForm((p) => ({ ...p, targetAccountId: e.target.value }))
                              }
                              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                            >
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Категория
                            </label>
                            <input
                              type="text"
                              value={ledgerForm.category}
                              onChange={(e) =>
                                setLedgerForm((p) => ({ ...p, category: e.target.value }))
                              }
                              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                            />
                          </div>
                        )}

                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Сумма (₽) *
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="1"
                            value={ledgerForm.amountRubles}
                            onChange={(e) =>
                              setLedgerForm((p) => ({ ...p, amountRubles: e.target.value }))
                            }
                            placeholder="0.00"
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                            required
                          />
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Описание / основание операции *
                          </label>
                          <input
                            type="text"
                            value={ledgerForm.description}
                            onChange={(e) =>
                              setLedgerForm((p) => ({ ...p, description: e.target.value }))
                            }
                            placeholder="Подробное назначение операции"
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                            required
                          />
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Провести операцию в регистре
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {ledger
                        .filter(
                          (l) =>
                            activeSection === 'cash_bank' ||
                            l.entryType === 'operating_expense' ||
                            l.entryType === 'delivery_expense'
                        )
                        .map((l) => (
                          <div
                            key={l.id}
                            className={`p-4 space-y-1.5 text-xs ${
                              l.status === 'reversed' ? 'opacity-50 line-through bg-slate-50' : ''
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-semibold text-slate-900 break-words">
                                {translateEntryType(l.entryType)}
                              </div>
                              <div
                                className={`font-mono font-bold shrink-0 ${
                                  l.direction === 'in' ? 'text-emerald-700' : 'text-slate-900'
                                }`}
                              >
                                {l.direction === 'in' ? '+' : '−'}
                                {formatMoney(l.amountKopecks)}
                              </div>
                            </div>
                            <div className="text-slate-500 flex flex-wrap items-center gap-2">
                              <span className="font-mono">{formatDateRu(l.eventDate)}</span>
                              <span>·</span>
                              <span>{l.accountName}</span>
                              {l.category && (
                                <>
                                  <span>·</span>
                                  <span>{l.category}</span>
                                </>
                              )}
                            </div>
                            <div className="text-slate-700 break-words pt-0.5">{l.description}</div>
                          </div>
                        ))}
                    </div>

                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[680px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Дата</th>
                            <th className="py-3 px-4 font-medium">Счёт / Касса</th>
                            <th className="py-3 px-4 font-medium">Вид операции и категория</th>
                            <th className="py-3 px-4 font-medium">Основание</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Сумма</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {ledger
                            .filter(
                              (l) =>
                                activeSection === 'cash_bank' ||
                                l.entryType === 'operating_expense' ||
                                l.entryType === 'delivery_expense'
                            )
                            .map((l) => (
                              <tr
                                key={l.id}
                                className={l.status === 'reversed' ? 'opacity-50 line-through' : ''}
                              >
                                <td className="py-3 px-4 font-mono whitespace-nowrap">{formatDateRu(l.eventDate)}</td>
                                <td className="py-3 px-4">{l.accountName}</td>
                                <td className="py-3 px-4">
                                  <div className="font-medium text-slate-900">
                                    {translateEntryType(l.entryType)}
                                  </div>
                                  <div className="text-slate-500">{l.category}</div>
                                </td>
                                <td className="py-3 px-4 text-slate-700 break-words">{l.description}</td>
                                <td
                                  className={`py-3 px-4 font-mono text-right font-semibold whitespace-nowrap ${
                                    l.direction === 'in' ? 'text-emerald-700' : 'text-slate-900'
                                  }`}
                                >
                                  {l.direction === 'in' ? '+' : '−'}
                                  {formatMoney(l.amountKopecks)}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 10. ПРИБЫЛЬ И ОТЧЁТЫ ==================== */}
              {activeSection === 'reports' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                        Управленческая прибыль и отчёты за период
                      </h1>
                      <p className="text-xs text-slate-500 mt-1 break-words">
                        До уточнения налогового режима владельца показатель именуется «Управленческая прибыль (до налогообложения)».
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 no-print">
                      <input
                        type="date"
                        value={periodFrom}
                        onChange={(e) => setPeriodFrom(e.target.value)}
                        className="px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                      />
                      <span className="text-xs text-slate-500">—</span>
                      <input
                        type="date"
                        value={periodTo}
                        onChange={(e) => setPeriodTo(e.target.value)}
                        className="px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await downloadProtectedFile(
                              `/api/v1/reports/export/csv?from=${periodFrom}&to=${periodTo}`,
                              `report_${periodFrom}_${periodTo}.csv`
                            );
                            notify('success', 'Отчёт CSV успешно скачан.');
                          } catch (err) {
                            notify('error', 'Ошибка скачивания отчёта: ' + (err instanceof Error ? err.message : 'Неизвестная ошибка'));
                          }
                        }}
                        className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5 shrink-0" />
                        <span>Экспорт Excel / CSV</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => window.print()}
                        className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center gap-1.5"
                      >
                        <Printer className="w-3.5 h-3.5 shrink-0" />
                        <span>Печать отчёта (PDF)</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* P&L vs Cost of Goods */}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                      <h2 className="text-sm sm:text-base font-semibold text-slate-900 border-b border-slate-200 pb-2 break-words">
                        1. Отчёт по портфелю договоров и управленческой прибыли
                      </h2>
                      <div className="space-y-2.5 text-xs">
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Объём продаж по оформленным договорам (с наценкой):
                          </span>
                          <span className="font-mono font-semibold whitespace-nowrap shrink-0">
                            {formatMoney(financialMetrics.portfolioSaleVolumeKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Полная себестоимость реализованных по договорам товаров (закупка + доставка):
                          </span>
                          <span className="font-mono whitespace-nowrap shrink-0">
                            {formatMoney(financialMetrics.portfolioCostOfGoodsKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Ожидаемая валовая наценка по действующему портфелю:
                          </span>
                          <span className="font-mono font-semibold text-emerald-700 whitespace-nowrap shrink-0">
                            {formatMoney(financialMetrics.totalExpectedMarkupKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Фактически реализованная наценка в поступивших платежах:
                          </span>
                          <span className="font-mono font-semibold text-emerald-700 whitespace-nowrap shrink-0">
                            {formatMoney(financialMetrics.realizedGrossMarginKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Операционные расходы за период ({formatDateRu(periodFrom)} — {formatDateRu(periodTo)}):
                          </span>
                          <span className="font-mono text-red-600 whitespace-nowrap shrink-0">
                            −{formatMoney(financialMetrics.operatingExpensesKopecks)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 py-2.5 bg-slate-50 px-3 rounded-lg font-semibold text-xs sm:text-sm">
                          <span className="break-words">Управленческая прибыль (до налогообложения):</span>
                          <span className="font-mono text-emerald-700 whitespace-nowrap">
                            {formatMoney(financialMetrics.managementNetProfitKopecks)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Cash Flow Statement */}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                      <h2 className="text-sm sm:text-base font-semibold text-slate-900 border-b border-slate-200 pb-2 break-words">
                        2. Отчёт о движении денежных средств (ДДС) за период
                      </h2>
                      <div className="space-y-2.5 text-xs">
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">Поступления от клиентов по рассрочке:</span>
                          <span className="font-mono font-semibold text-emerald-700 whitespace-nowrap shrink-0">
                            +{formatMoney(financialMetrics.clientInflowsKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Оплата закупок товаров и доставки поставщикам:
                          </span>
                          <span className="font-mono whitespace-nowrap shrink-0">
                            −{formatMoney(financialMetrics.purchaseOutflowsKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">Оплата операционных расходов:</span>
                          <span className="font-mono whitespace-nowrap shrink-0">
                            −{formatMoney(financialMetrics.operatingExpensesKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">
                            Собственные пополнения владельца (капитал, не выручка):
                          </span>
                          <span className="font-mono text-slate-800 whitespace-nowrap shrink-0">
                            +{formatMoney(financialMetrics.ownerInjectionsKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1 border-b border-slate-100">
                          <span className="text-slate-600 break-words">Личные изъятия владельца:</span>
                          <span className="font-mono text-slate-800 whitespace-nowrap shrink-0">
                            −{formatMoney(financialMetrics.ownerWithdrawalsKopecks)}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3 py-1">
                          <span className="text-slate-600 break-words">
                            Внутренние переводы между счетами (нейтрально к прибыли):
                          </span>
                          <span className="font-mono text-slate-500 whitespace-nowrap shrink-0">
                            {formatMoney(financialMetrics.internalTransfersKopecks)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 11. ДОКУМЕНТЫ И ШАБЛОНЫ ==================== */}
              {activeSection === 'documents' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                        Защищённое хранилище документов и печатные шаблоны
                      </h1>
                      <p className="text-xs text-slate-500 mt-1 break-words">
                        При загрузке проверяются расширение, размер (до 10 МБ) и бинарная сигнатура содержимого (magic bytes: PDF, PNG, JPEG).
                      </p>
                    </div>
                    {canWrite && (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer flex items-center gap-1.5">
                          <Upload className="w-3.5 h-3.5 shrink-0" />
                          <span>Загрузить файл (PDF/PNG/JPG)</span>
                          <input
                            type="file"
                            accept=".pdf,.png,.jpg,.jpeg,.txt,.csv"
                            onChange={handleFileUpload}
                            className="hidden"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={handleCreateSamplePdfReceipt}
                          className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Сформировать тестовый чек PDF
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Document Templates Generator */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Генерация документов по шаблонам для действующих договоров
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {contracts.map((c) => (
                        <div
                          key={c.id}
                          className="p-3.5 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 break-words">
                              {c.contractNumber} · {c.clientName}
                            </div>
                            <div className="text-slate-500 break-words">{c.itemTitle}</div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setPrintTemplateModal({ contract: c, type: 'contract' })
                              }
                              className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50"
                            >
                              Договор
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setPrintTemplateModal({ contract: c, type: 'schedule' })
                              }
                              className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50"
                            >
                              График
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setPrintTemplateModal({ contract: c, type: 'handover' })
                              }
                              className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50"
                            >
                              Акт передачи
                            </button>
                            <button
                              type="button"
                              onClick={() => setPrintTemplateModal({ contract: c, type: 'payoff' })}
                              className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50"
                            >
                              Справка о погашении
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {documents.map((d) => (
                        <div key={d.id} className="p-4 space-y-2.5 text-xs">
                          <div className="flex items-start gap-2">
                            <FileText className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-slate-900 break-words">{d.title}</div>
                              <div className="font-mono text-[11px] text-slate-500 break-all mt-0.5">
                                {d.originalFilename} · {d.sizeBytes} Б · {formatDateTimeRu(d.createdAt)}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 pt-1">
                            <button
                              type="button"
                              onClick={() => setPreviewingDocument(d)}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 flex items-center gap-1"
                            >
                              <Eye className="w-3 h-3 shrink-0" />
                              <span>Просмотр</span>
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await downloadProtectedFile(
                                    `/api/v1/documents/${d.id}/download`,
                                    d.originalFilename || `${d.id}.bin`
                                  );
                                  notify('success', `Файл «${d.originalFilename}» скачан (SHA-256 проверен).`);
                                } catch (err) {
                                  notify(
                                    'error',
                                    err instanceof Error ? err.message : 'Ошибка скачивания документа'
                                  );
                                }
                              }}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 flex items-center gap-1"
                            >
                              <Download className="w-3 h-3 shrink-0" />
                              <span>Скачать</span>
                            </button>
                            {isOwner && (
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/v1/documents/${d.id}`, {
                                      method: 'DELETE',
                                    });
                                    await loadFullState();
                                    notify('success', `Документ «${d.title}» удалён.`);
                                  } catch (err) {
                                    notify(
                                      'error',
                                      err instanceof Error ? err.message : 'Ошибка удаления документа'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                              >
                                Удалить
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {documents.length === 0 && (
                        <div className="p-8 text-center text-xs text-slate-500">
                          Нет загруженных файлов. Нажмите «Сформировать тестовый чек PDF» или загрузите файл.
                        </div>
                      )}
                    </div>

                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[760px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">Наименование документа</th>
                            <th className="py-3 px-4 font-medium">Исходный файл и MIME</th>
                            <th className="py-3 px-4 font-medium">Контрольная сумма SHA-256</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Размер</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Дата загрузки</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Действия</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {documents.map((d) => (
                            <tr key={d.id}>
                              <td className="py-3 px-4 font-medium text-slate-900">
                                <div className="flex items-center gap-2">
                                  <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                                  <span className="break-words">{d.title}</span>
                                </div>
                              </td>
                              <td className="py-3 px-4 font-mono text-slate-600 break-all">
                                {d.originalFilename} · {d.mimeType}
                              </td>
                              <td className="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                                {d.sha256Hash.slice(0, 24)}...
                              </td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">{d.sizeBytes} Б</td>
                              <td className="py-3 px-4 font-mono text-right whitespace-nowrap">
                                {formatDateTimeRu(d.createdAt)}
                              </td>
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setPreviewingDocument(d)}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 flex items-center gap-1"
                                  >
                                    <Eye className="w-3 h-3 shrink-0" />
                                    <span>Просмотр</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await downloadProtectedFile(
                                          `/api/v1/documents/${d.id}/download`,
                                          d.originalFilename || `${d.id}.bin`
                                        );
                                        notify('success', `Файл «${d.originalFilename}» скачан (SHA-256 проверен).`);
                                      } catch (err) {
                                        notify(
                                          'error',
                                          err instanceof Error ? err.message : 'Ошибка скачивания документа'
                                        );
                                      }
                                    }}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 flex items-center gap-1"
                                  >
                                    <Download className="w-3 h-3 shrink-0" />
                                    <span>Скачать</span>
                                  </button>
                                  {isOwner && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        try {
                                          await apiFetch(`/api/v1/documents/${d.id}`, {
                                            method: 'DELETE',
                                          });
                                          await loadFullState();
                                          notify('success', `Документ «${d.title}» удалён.`);
                                        } catch (err) {
                                          notify(
                                            'error',
                                            err instanceof Error ? err.message : 'Ошибка удаления документа'
                                          );
                                        }
                                      }}
                                      className="px-2.5 py-1 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                                    >
                                      Удалить
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                          {documents.length === 0 && (
                            <tr>
                              <td colSpan={6} className="py-8 text-center text-slate-500">
                                Нет загруженных файлов. Нажмите «Сформировать тестовый чек PDF» или загрузите файл.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 12. ПОЛЬЗОВАТЕЛИ И ПРАВА (ADMIN USER MANAGEMENT) ==================== */}
              {activeSection === 'users' && isOwner && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Управление пользователями (только для администратора)
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Самостоятельная регистрация отключена. Учётные записи создаются, активируются и блокируются вручную администратором. Первоначальный пароль передаётся сотруднику по защищённому каналу.
                    </p>
                  </div>

                  {/* Create User Form */}
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiFetch('/api/v1/users', {
                          method: 'POST',
                          body: JSON.stringify(adminNewUserForm),
                        });
                        setAdminNewUserForm({
                          phone: '',
                          password: '',
                          fullName: '',
                          role: 'staff',
                          mustChangePassword: false,
                        });
                        await loadFullState();
                        notify('success', 'Пользователь успешно создан.');
                      } catch (err) {
                        notify('error', err instanceof Error ? err.message : 'Ошибка создания пользователя');
                      }
                    }}
                    className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                  >
                    <h2 className="text-sm font-semibold text-slate-900">
                      Создать новую учётную запись
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Номер телефона *
                        </label>
                        <input
                          type="tel"
                          value={adminNewUserForm.phone}
                          onChange={(e) =>
                            setAdminNewUserForm((p) => ({ ...p, phone: e.target.value }))
                          }
                          placeholder="+7 928 000-00-00"
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Первоначальный пароль (от 8 симв.) *
                        </label>
                        <input
                          type="password"
                          value={adminNewUserForm.password}
                          onChange={(e) =>
                            setAdminNewUserForm((p) => ({ ...p, password: e.target.value }))
                          }
                          placeholder="Минимум 8 символов"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Имя / комментарий (необязательно)
                        </label>
                        <input
                          type="text"
                          value={adminNewUserForm.fullName}
                          onChange={(e) =>
                            setAdminNewUserForm((p) => ({ ...p, fullName: e.target.value }))
                          }
                          placeholder="Напр.: Оператор кассы"
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Роль доступа
                        </label>
                        <select
                          value={adminNewUserForm.role}
                          onChange={(e) =>
                            setAdminNewUserForm((p) => ({
                              ...p,
                              role: e.target.value as UserRole,
                            }))
                          }
                          className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="staff">Оператор (staff)</option>
                          <option value="readonly">Только чтение (readonly)</option>
                          <option value="owner">Администратор / Владелец (owner)</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={adminNewUserForm.mustChangePassword}
                          onChange={(e) =>
                            setAdminNewUserForm((p) => ({
                              ...p,
                              mustChangePassword: e.target.checked,
                            }))
                          }
                          className="rounded border-slate-300"
                        />
                        <span>Запросить смену пароля при первом входе (необязательно, по умолчанию выключено)</span>
                      </label>
                      <button
                        type="submit"
                        className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                      >
                        Создать пользователя
                      </button>
                    </div>
                  </form>

                  {/* Edit User Phone / Role Modal-Inline Box */}
                  {editingUser && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await apiFetch(`/api/v1/users/${editingUser.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                              phone: editingUser.phone,
                              fullName: editingUser.fullName,
                              role: editingUser.role,
                            }),
                          });
                          setEditingUser(null);
                          await loadFullState();
                          notify('success', 'Данные учётной записи обновлены.');
                        } catch (err) {
                          notify('error', err instanceof Error ? err.message : 'Ошибка обновления');
                        }
                      }}
                      className="bg-white border border-slate-900 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Изменение номера телефона и роли пользователя
                        </h3>
                        <button
                          type="button"
                          onClick={() => setEditingUser(null)}
                          className="text-xs text-slate-500 hover:text-slate-900"
                        >
                          Отмена
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Номер телефона
                          </label>
                          <input
                            type="tel"
                            value={editingUser.phone}
                            onChange={(e) =>
                              setEditingUser((p) => (p ? { ...p, phone: e.target.value } : null))
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Имя / описание
                          </label>
                          <input
                            type="text"
                            value={editingUser.fullName}
                            onChange={(e) =>
                              setEditingUser((p) => (p ? { ...p, fullName: e.target.value } : null))
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Роль
                          </label>
                          <select
                            value={editingUser.role}
                            onChange={(e) =>
                              setEditingUser((p) =>
                                p ? { ...p, role: e.target.value as UserRole } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="staff">staff (Оператор)</option>
                            <option value="readonly">readonly (Только чтение)</option>
                            <option value="owner">owner (Администратор)</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                        >
                          Сохранить изменения
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Reset User Password Box */}
                  {resetPasswordModal && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await apiFetch(`/api/v1/users/${resetPasswordModal.id}/reset-password`, {
                            method: 'POST',
                            body: JSON.stringify({
                              newPassword: resetPasswordModal.newPassword,
                              mustChangePassword: resetPasswordModal.mustChangePassword,
                            }),
                          });
                          setResetPasswordModal(null);
                          await loadFullState();
                          notify(
                            'success',
                            'Пароль сброшен, все старые сессии пользователя немедленно отозваны.'
                          );
                        } catch (err) {
                          notify('error', err instanceof Error ? err.message : 'Ошибка сброса пароля');
                        }
                      }}
                      className="bg-white border border-slate-900 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 break-words">
                          Сброс пароля для номера {resetPasswordModal.phone}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setResetPasswordModal(null)}
                          className="text-xs text-slate-500 hover:text-slate-900 shrink-0"
                        >
                          Отмена
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Новый временный пароль (от 8 символов) *
                          </label>
                          <input
                            type="password"
                            value={resetPasswordModal.newPassword}
                            onChange={(e) =>
                              setResetPasswordModal((p) =>
                                p ? { ...p, newPassword: e.target.value } : null
                              )
                            }
                            placeholder="Введите новый пароль"
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                            required
                          />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={resetPasswordModal.mustChangePassword}
                              onChange={(e) =>
                                setResetPasswordModal((p) =>
                                  p ? { ...p, mustChangePassword: e.target.checked } : null
                                )
                              }
                            />
                            <span>Запросить смену при входе (необязательно)</span>
                          </label>
                          <button
                            type="submit"
                            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                          >
                            Установить пароль и отозвать сессии
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  {/* Users List */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    {/* Mobile Cards */}
                    <div className="md:hidden divide-y divide-slate-200">
                      {users.map((u) => (
                        <div key={u.id} className="p-4 space-y-3 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-mono font-bold text-sm text-slate-900">{u.phone}</div>
                              <div className="text-slate-500 break-words">{u.fullName}</div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px]">
                                {u.role}
                              </span>
                              {u.status === 'active' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200">
                                  Активен
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-red-700 bg-red-50 border border-red-200">
                                  Заблокирован
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                            <div>
                              Пароль:{' '}
                              {u.passwordChangedAt ? (
                                <span className="text-emerald-700 font-medium">
                                  Изменён ({formatDateTimeRu(u.passwordChangedAt)})
                                </span>
                              ) : u.mustChangePassword ? (
                                <span className="text-amber-700 font-medium">Временный (запрошена смена)</span>
                              ) : (
                                <span className="text-slate-700 font-medium">Первоначальный</span>
                              )}
                            </div>
                            <div className="font-mono text-slate-400">
                              Создан: {formatDateTimeRu(u.createdAt)}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() =>
                                setEditingUser({
                                  id: u.id,
                                  phone: u.phone,
                                  fullName: u.fullName,
                                  role: u.role,
                                })
                              }
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                              Изменить номер / роль
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setResetPasswordModal({
                                  id: u.id,
                                  phone: u.phone,
                                  newPassword: '',
                                  mustChangePassword: false,
                                })
                              }
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                            >
                              Сбросить пароль
                            </button>
                            {u.status === 'blocked' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await apiFetch(`/api/v1/users/${u.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ status: 'active' }),
                                  });
                                  await loadFullState();
                                  notify('success', `Аккаунт ${u.phone} активирован.`);
                                }}
                                className="px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg"
                              >
                                Активировать
                              </button>
                            )}
                            {u.id !== currentUser?.id && u.status === 'active' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await apiFetch(`/api/v1/users/${u.id}/block`, {
                                    method: 'POST',
                                  });
                                  await loadFullState();
                                  notify(
                                    'success',
                                    `Аккаунт ${u.phone} заблокирован, активные сессии отозваны.`
                                  );
                                }}
                                className="px-2.5 py-1.5 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                              >
                                Заблокировать
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full min-w-[780px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-3 px-4 font-medium">Номер телефона и описание</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Статус аккаунта</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Статус пароля</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Роль</th>
                            <th className="py-3 px-4 font-medium whitespace-nowrap">Дата создания</th>
                            <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Действия администратора</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {users.map((u) => (
                            <tr key={u.id}>
                              <td className="py-3 px-4">
                                <div className="font-mono font-semibold text-slate-900">{u.phone}</div>
                                <div className="text-slate-500 break-words">{u.fullName}</div>
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                {u.status === 'active' ? (
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                    Активен
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium text-red-700 bg-red-50 border border-red-200">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                                    Заблокирован
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                {u.passwordChangedAt ? (
                                  <div className="space-y-0.5">
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                      Изменён
                                    </span>
                                    <div className="text-[10px] font-mono text-slate-500">
                                      {formatDateTimeRu(u.passwordChangedAt)}
                                    </div>
                                  </div>
                                ) : u.mustChangePassword ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                                    ⏳ Временный (запрошена смена)
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                                    🔑 Первоначальный (активен)
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-4 font-mono whitespace-nowrap">{u.role}</td>
                              <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                                {formatDateTimeRu(u.createdAt)}
                              </td>
                              <td className="py-3 px-4 text-right whitespace-nowrap">
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEditingUser({
                                        id: u.id,
                                        phone: u.phone,
                                        fullName: u.fullName,
                                        role: u.role,
                                      })
                                    }
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                                  >
                                    Изменить номер / роль
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setResetPasswordModal({
                                        id: u.id,
                                        phone: u.phone,
                                        newPassword: '',
                                        mustChangePassword: false,
                                      })
                                    }
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                                  >
                                    Сбросить пароль
                                  </button>
                                  {u.status === 'blocked' && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        await apiFetch(`/api/v1/users/${u.id}`, {
                                          method: 'PATCH',
                                          body: JSON.stringify({ status: 'active' }),
                                        });
                                        await loadFullState();
                                        notify('success', `Аккаунт ${u.phone} активирован.`);
                                      }}
                                      className="px-2.5 py-1 text-xs font-medium text-white bg-slate-900 rounded-lg"
                                    >
                                      Активировать
                                    </button>
                                  )}
                                  {u.id !== currentUser?.id && u.status === 'active' && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        await apiFetch(`/api/v1/users/${u.id}/block`, {
                                          method: 'POST',
                                        });
                                        await loadFullState();
                                        notify(
                                          'success',
                                          `Аккаунт ${u.phone} заблокирован, активные сессии отозваны.`
                                        );
                                      }}
                                      className="px-2.5 py-1 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                                    >
                                      Заблокировать
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 13. ГИБКИЕ НАСТРОЙКИ РАССРОЧКИ ==================== */}
              {activeSection === 'installment_settings' && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Гибкие версионируемые настройки рассрочки
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Изменение сроков, процентов наценки, первоначального взноса и правил округления применяется к новым договорам. Уже оформленные договоры сохраняют свои зафиксированные условия.
                    </p>
                  </div>

                  {statusRules && (
                    <StatusRulesConfigCard
                      statusRules={statusRules}
                      isOwner={isOwner}
                      apiFetch={apiFetch}
                      onRefresh={loadFullState}
                    />
                  )}

                  {/* Existing Installment Plans */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {plans.map((p) => (
                      <div
                        key={p.id}
                        className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-base font-bold text-slate-900 break-words">{p.name}</div>
                            <div className="text-xs text-slate-500 font-mono">
                              Версия v{p.version} · {p.isActive ? 'Активен' : 'Отключён для новых'}
                            </div>
                          </div>
                          {isOwner && (
                            <button
                              type="button"
                              onClick={() =>
                                setEditingPlan({
                                  id: p.id,
                                  name: p.name,
                                  termMonths: String(p.termMonths),
                                  markupPercent: String(p.markupPercent),
                                  downPaymentPercent: String(p.downPaymentPercent),
                                  roundingRule: p.roundingRule,
                                  earlyPayoffDiscountPercent: String(p.earlyPayoffDiscountPercent),
                                  isActive: p.isActive,
                                  reason: 'Плановое изменение условий тарифа владельцем',
                                })
                              }
                              className="text-xs font-medium text-slate-900 underline shrink-0"
                            >
                              Изменить
                            </button>
                          )}
                        </div>

                        <div className="space-y-1.5 text-xs border-t border-slate-100 pt-3">
                          <div className="flex justify-between gap-2">
                            <span className="text-slate-500">Срок рассрочки:</span>
                            <span className="font-mono font-semibold">{p.termMonths} мес.</span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span className="text-slate-500">Наценка на себестоимость:</span>
                            <span className="font-mono font-semibold text-emerald-700">
                              {p.markupPercent}%
                            </span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span className="text-slate-500">Стандартный первый взнос:</span>
                            <span className="font-mono font-semibold">{p.downPaymentPercent}%</span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span className="text-slate-500">Округление графика:</span>
                            <span className="font-mono">{translateRoundingRule(p.roundingRule)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Edit existing plan modal / form */}
                  {editingPlan && isOwner && (
                    <form
                      onSubmit={handleUpdatePlan}
                      className="bg-white border border-slate-900 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 break-words">
                          Редактирование тарифа «{editingPlan.name}» (создаст новую версию настроек)
                        </h3>
                        <button
                          type="button"
                          onClick={() => setEditingPlan(null)}
                          className="text-xs text-slate-500 shrink-0"
                        >
                          Отмена
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Название тарифа
                          </label>
                          <input
                            type="text"
                            value={editingPlan.name}
                            onChange={(e) =>
                              setEditingPlan((p) => (p ? { ...p, name: e.target.value } : null))
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Срок (месяцев)
                          </label>
                          <input
                            type="number"
                            value={editingPlan.termMonths}
                            onChange={(e) =>
                              setEditingPlan((p) =>
                                p ? { ...p, termMonths: e.target.value } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Процент наценки (%)
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={editingPlan.markupPercent}
                            onChange={(e) =>
                              setEditingPlan((p) =>
                                p ? { ...p, markupPercent: e.target.value } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Первоначальный взнос (%)
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={editingPlan.downPaymentPercent}
                            onChange={(e) =>
                              setEditingPlan((p) =>
                                p ? { ...p, downPaymentPercent: e.target.value } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Правило округления
                          </label>
                          <select
                            value={editingPlan.roundingRule}
                            onChange={(e) =>
                              setEditingPlan((p) =>
                                p ? { ...p, roundingRule: e.target.value as RoundingRule } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="kopeck">До копейки</option>
                            <option value="ruble">До рубля</option>
                            <option value="ten_rubles">До 10 рублей</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Статус срока рассрочки
                          </label>
                          <select
                            value={editingPlan.isActive ? '1' : '0'}
                            onChange={(e) =>
                              setEditingPlan((p) =>
                                p ? { ...p, isActive: e.target.value === '1' } : null
                              )
                            }
                            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="1">Включён для новых договоров</option>
                            <option value="0">Отключён (старые договоры продолжают действовать)</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                        >
                          Сохранить новую версию тарифа
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Add New Plan Form (Owner) */}
                  {isOwner && (
                    <form
                      onSubmit={handleCreatePlan}
                      className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
                    >
                      <h2 className="text-sm font-semibold text-slate-900">
                        Добавить новый срок / тариф рассрочки без изменения кода
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                        <input
                          type="text"
                          value={newPlanForm.name}
                          onChange={(e) => setNewPlanForm((p) => ({ ...p, name: e.target.value }))}
                          placeholder="Название (напр. 9 месяцев) *"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="number"
                          min="1"
                          max="120"
                          value={newPlanForm.termMonths}
                          onChange={(e) =>
                            setNewPlanForm((p) => ({ ...p, termMonths: e.target.value }))
                          }
                          placeholder="Месяцев *"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="number"
                          step="0.1"
                          value={newPlanForm.markupPercent}
                          onChange={(e) =>
                            setNewPlanForm((p) => ({ ...p, markupPercent: e.target.value }))
                          }
                          placeholder="Наценка % *"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                        <input
                          type="number"
                          step="0.1"
                          value={newPlanForm.downPaymentPercent}
                          onChange={(e) =>
                            setNewPlanForm((p) => ({ ...p, downPaymentPercent: e.target.value }))
                          }
                          placeholder="Первый взнос % *"
                          className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                          required
                        />
                        <button
                          type="submit"
                          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Добавить срок
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Settings Change History */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200">
                      <h3 className="text-sm font-semibold text-slate-900 break-words">
                        Журнал истории изменений настроек рассрочки (старое и новое значение, автор, время)
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[680px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">Время</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">Пользователь</th>
                            <th className="py-2.5 px-4 font-medium">Старое значение</th>
                            <th className="py-2.5 px-4 font-medium">Новое значение</th>
                            <th className="py-2.5 px-4 font-medium">Основание</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {settingsHistory.map((sh) => (
                            <tr key={sh.id}>
                              <td className="py-2.5 px-4 font-mono whitespace-nowrap">
                                {formatDateTimeRu(sh.createdAt)}
                              </td>
                              <td className="py-2.5 px-4 font-mono whitespace-nowrap">{sh.changedByEmail}</td>
                              <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500 break-all">
                                {sh.oldValueJson}
                              </td>
                              <td className="py-2.5 px-4 font-mono text-[11px] text-slate-900 break-all">
                                {sh.newValueJson}
                              </td>
                              <td className="py-2.5 px-4 text-slate-600 break-words">{sh.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ==================== 14. НАСТРОЙКИ БЕЗОПАСНОСТИ И РЕЗЕРВНЫЕ КОПИИ ==================== */}
              {activeSection === 'security_settings' && isOwner && (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">
                      Настройки безопасности, шифрованные резервные копии и журнал аудита
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 break-words">
                      Управление вторым фактором (TOTP MFA), резервное копирование AES-256-GCM с тестом восстановления и неизменяемый журнал событий.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* TOTP MFA Configuration */}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
                      <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-slate-900 shrink-0" />
                        <h2 className="text-sm font-semibold text-slate-900 break-words">
                          Двухфакторная аутентификация владельца (TOTP MFA, RFC 6238)
                        </h2>
                      </div>
                      <p className="text-xs text-slate-600">
                        Статус MFA:{' '}
                        <strong>
                          {currentUser?.mfaEnabled
                            ? 'Включена (при входе требуется 6-значный код TOTP)'
                            : 'Отключена'}
                        </strong>
                      </p>

                      {!currentUser?.mfaEnabled ? (
                        <div className="space-y-3">
                          <button
                            type="button"
                            onClick={async () => {
                              const info = await apiFetch('/api/v1/auth/mfa/setup', {
                                method: 'POST',
                              });
                              setMfaSetupInfo(info);
                              setMfaConfirmCode(info.currentSampleCode);
                            }}
                            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
                          >
                            Сгенерировать секретный ключ TOTP
                          </button>

                          {mfaSetupInfo && (
                            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2">
                              <div className="break-all">
                                Секрет Base32:{' '}
                                <span className="font-mono font-bold">{mfaSetupInfo.secret}</span>
                              </div>
                              <div>
                                Текущий 30-секундный код:{' '}
                                <span className="font-mono font-semibold text-emerald-700">
                                  {mfaSetupInfo.currentSampleCode}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 pt-1">
                                <input
                                  type="text"
                                  value={mfaConfirmCode}
                                  onChange={(e) => setMfaConfirmCode(e.target.value)}
                                  className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg w-32 bg-white"
                                />
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await apiFetch('/api/v1/auth/mfa/enable', {
                                      method: 'POST',
                                      body: JSON.stringify({ code: mfaConfirmCode }),
                                    });
                                    setCurrentUser((u) => (u ? { ...u, mfaEnabled: true } : null));
                                    setMfaSetupInfo(null);
                                    await loadFullState();
                                    notify('success', 'Двухфакторная аутентификация TOTP MFA успешно активирована.');
                                  }}
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg"
                                >
                                  Подтвердить и включить MFA
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={async () => {
                            await apiFetch('/api/v1/auth/mfa/disable', { method: 'POST' });
                            setCurrentUser((u) => (u ? { ...u, mfaEnabled: false } : null));
                            await loadFullState();
                            notify('success', 'TOTP MFA отключена.');
                          }}
                          className="px-4 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg"
                        >
                          Отключить TOTP MFA
                        </button>
                      )}
                    </div>

                    {/* Encrypted Backups & Restore Verification */}
                    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-slate-900 break-words">
                          Шифрованное резервное копирование (AES-256-GCM)
                        </h2>
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="px-3 py-1.5 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer">
                            <span>Восстановить из файла (.enc.json)</span>
                            <input
                              type="file"
                              accept=".json,application/json"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                try {
                                  const text = await file.text();
                                  const res = await apiFetch('/api/v1/security/backups/restore-file', {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      filename: file.name,
                                      envelopeContent: text,
                                    }),
                                  });
                                  await loadFullState();
                                  notify(
                                    'success',
                                    `База данных полностью восстановлена из файла «${file.name}» (договоров: ${res.contractsCount}, клиентов: ${res.clientsCount}).`
                                  );
                                } catch (err) {
                                  notify(
                                    'error',
                                    err instanceof Error
                                      ? err.message
                                      : 'Ошибка восстановления из файла копии'
                                  );
                                }
                              }}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch('/api/v1/security/backups', { method: 'POST' });
                                await loadFullState();
                                notify(
                                  'success',
                                  'Создана зашифрованная резервная копия (AES-256-GCM) со сверкой регистров.'
                                );
                              } catch (err) {
                                notify(
                                  'error',
                                  err instanceof Error ? err.message : 'Ошибка создания копии'
                                );
                              }
                            }}
                            className="px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg"
                          >
                            Создать резервную копию
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {backups.map((b) => (
                          <div
                            key={b.id}
                            className="p-3 border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-mono font-medium text-slate-900 break-all">
                                {b.filename}
                              </div>
                              <div className="text-slate-500 mt-0.5 break-words">
                                {b.encryptedAlg} · SHA-256: {b.sha256Hash.slice(0, 12)}... ·{' '}
                                {b.verifiedRestoreAt
                                  ? `Восстановление проверено: ${formatDateTimeRu(b.verifiedRestoreAt)}`
                                  : 'Ожидает теста восстановления'}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await downloadProtectedFile(
                                      `/api/v1/security/backups/${b.id}/download`,
                                      b.filename
                                    );
                                    notify('success', `Файл копии ${b.filename} скачан.`);
                                  } catch (err) {
                                    notify(
                                      'error',
                                      err instanceof Error ? err.message : 'Ошибка скачивания копии'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                              >
                                Скачать
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/v1/security/backups/${b.id}/verify`, {
                                      method: 'POST',
                                    });
                                    await loadFullState();
                                    notify(
                                      'success',
                                      'Тест восстановления пройден: копия расшифрована, SHA-256 и финансовые регистры полностью совпали.'
                                    );
                                  } catch (err) {
                                    notify(
                                      'error',
                                      err instanceof Error ? err.message : 'Ошибка проверки копии'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                              >
                                Проверить целостность
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/v1/security/backups/${b.id}/restore`, {
                                      method: 'POST',
                                    });
                                    await loadFullState();
                                    notify(
                                      'success',
                                      `База данных успешно восстановлена из копии ${b.filename}. Все регистры сверены.`
                                    );
                                  } catch (err) {
                                    notify(
                                      'error',
                                      err instanceof Error ? err.message : 'Ошибка восстановления'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                              >
                                Восстановить БД
                              </button>
                            </div>
                          </div>
                        ))}
                        {backups.length === 0 && (
                          <div className="text-xs text-slate-500 py-4 text-center">
                            Нажмите «Создать резервную копию» для формирования зашифрованного снимка БД.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Clean Production Reset Card (Owner Only) */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-1 max-w-2xl">
                      <h3 className="text-sm font-semibold text-slate-900">
                        Чистый старт для продакшена (очистка демо и тестовых записей)
                      </h3>
                      <p className="text-xs text-slate-600 break-words">
                        Перед очисткой автоматически создаётся зашифрованная резервная копия (AES-256-GCM). Удаляются только тестовые договоры, клиенты, платежи и проводки; ваша учётная запись владельца ({currentUser?.phone}), тарифы рассрочки и счета кассы/банка (с балансом 0,00 ₽) полностью сохраняются.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!confirmCleanResetDb ? (
                        <button
                          type="button"
                          onClick={() => setConfirmCleanResetDb(true)}
                          className="px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                        >
                          Очистить базу для чистого старта
                        </button>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const res = await apiFetch('/api/v1/security/database/clean-reset', {
                                  method: 'POST',
                                  body: JSON.stringify({ keepStaffUsers: true }),
                                });
                                setConfirmCleanResetDb(false);
                                await loadFullState();
                                notify(
                                  'success',
                                  `База очищена для продакшена (предварительная копия: ${res.backupFilename}). Касса и банк: 0,00 ₽.`
                                );
                              } catch (err) {
                                notify(
                                  'error',
                                  err instanceof Error ? err.message : 'Ошибка очистки базы данных'
                                );
                              }
                            }}
                            className="px-3.5 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
                          >
                            Подтвердить очистку (с бэкапом)
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmCleanResetDb(false)}
                            className="px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
                          >
                            Отмена
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Immutable Audit Log */}
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
                    <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200">
                      <h3 className="text-sm font-semibold text-slate-900 break-words">
                        Защищённый журнал аудита безопасности и финансовых действий
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">Время (UTC)</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">Пользователь</th>
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">Код события</th>
                            <th className="py-2.5 px-4 font-medium">Описание действия</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {auditLogs.map((a) => (
                            <tr key={a.id}>
                              <td className="py-2.5 px-4 font-mono whitespace-nowrap">
                                {formatDateTimeRu(a.createdAt)}
                              </td>
                              <td className="py-2.5 px-4 font-mono whitespace-nowrap">{a.actorEmail}</td>
                              <td className="py-2.5 px-4 font-mono text-slate-800 whitespace-nowrap">{a.action}</td>
                              <td className="py-2.5 px-4 text-slate-700 break-words">{a.summary}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Modals */}
      {showNewContractModal && (
        <NewContractModal
          clients={clients}
          purchases={purchases}
          plans={plans}
          accounts={accounts}
          onClose={() => setShowNewContractModal(false)}
          apiFetch={apiFetch}
          onSubmit={async (payload) => {
            await apiFetch('/api/v1/contracts', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
            await loadFullState();
            notify('success', 'Договор успешно оформлен и активирован.');
          }}
        />
      )}

      {earlyPayoffContract && (
        <EarlyPayoffModal
          contract={earlyPayoffContract}
          accounts={accounts}
          isOwner={isOwner}
          onClose={() => setEarlyPayoffContract(null)}
          apiFetch={apiFetch}
          onSuccess={async () => {
            await loadFullState();
            notify('success', 'Досрочное погашение договора успешно проведено.');
          }}
        />
      )}

      {restructureContract && (
        <RestructureScheduleModal
          contract={contracts.find((c) => c.id === restructureContract.id) || restructureContract}
          isOwner={isOwner}
          onClose={() => setRestructureContract(null)}
          apiFetch={apiFetch}
          onSuccess={async () => {
            await loadFullState();
            notify(
              'success',
              'График договора обновлён с учётом выплаченных месяцев.'
            );
          }}
        />
      )}

      {printTemplateModal && (
        <PrintableDocumentModal
          contract={printTemplateModal.contract}
          templateType={printTemplateModal.type}
          onClose={() => setPrintTemplateModal(null)}
        />
      )}

      {allocatingPayment && (
        <ManualAllocationModal
          payment={allocatingPayment}
          contracts={contracts}
          onClose={() => setAllocatingPayment(null)}
          apiFetch={apiFetch}
          onSuccess={async () => {
            await loadFullState();
            notify('success', 'Сумма платежа успешно распределена по выбранным строкам графика.');
          }}
        />
      )}

      {showNewPaymentModal && (
        <NewPaymentModal
          clients={borrowerClients}
          contracts={contracts}
          accounts={accounts}
          onClose={() => setShowNewPaymentModal(false)}
          apiFetch={apiFetch}
          onSuccess={async () => {
            await loadFullState();
            notify('success', 'Поступление зарегистрировано в кассе и реестре платежей.');
          }}
        />
      )}

      {viewingClientCardId &&
        (() => {
          const targetClient = clients.find((c) => c.id === viewingClientCardId);
          if (!targetClient) return null;
          return (
            <ClientDetailsModal
              client={targetClient}
              contracts={contracts}
              documents={documents}
              onClose={() => setViewingClientCardId(null)}
              onRefresh={loadFullState}
              apiFetch={apiFetch}
              fetchProtectedBlob={fetchProtectedBlob}
              downloadProtectedFile={downloadProtectedFile}
              onOpenWhatsAppForContract={(contractId) => {
                setWhatsappTargetContractId(contractId);
                setActiveSection('whatsapp_contracts');
              }}
              onEditClient={(cl) => {
                setViewingClientCardId(null);
                setActiveSection('clients');
                setEditingClient({
                  id: cl.id,
                  fullName: cl.fullName,
                  phone: cl.phone,
                  secondaryPhone: cl.secondaryPhone || '',
                  documentRef: cl.documentRef || '',
                  address: cl.address || '',
                  notes: cl.notes || '',
                  status: cl.status,
                });
              }}
            />
          );
        })()}

      {previewingDocument && (
        <DocumentPreviewModal
          doc={previewingDocument}
          onClose={() => setPreviewingDocument(null)}
          fetchProtectedBlob={fetchProtectedBlob}
          downloadProtectedFile={downloadProtectedFile}
          onDeleteDocument={
            isOwner
              ? async (doc) => {
                  await apiFetch(`/api/v1/documents/${doc.id}`, {
                    method: 'DELETE',
                  });
                  await loadFullState();
                  notify('success', `Файл «${doc.originalFilename}» удалён.`);
                }
              : undefined
          }
        />
      )}

      {(showChangePasswordModal || (Boolean(currentUser?.mustChangePassword) && !passwordChangeDismissed)) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (passwordChangeLoading) return;
              setPasswordChangeLoading(true);
              try {
                const res = await apiFetch('/api/v1/auth/change-password', {
                  method: 'POST',
                  body: JSON.stringify(selfPasswordForm),
                });
                setSelfPasswordForm({ currentPassword: '', newPassword: '' });
                setPasswordChangeDismissed(true);
                setShowChangePasswordModal(false);
                setCurrentUser((prev) =>
                  prev
                    ? {
                        ...prev,
                        mustChangePassword: false,
                        passwordChangedAt: res.passwordChangedAt || new Date().toISOString(),
                      }
                    : null
                );
                await loadFullState();
                notify('success', 'Пароль успешно изменён.');
              } catch (err) {
                notify('error', err instanceof Error ? err.message : 'Ошибка смены пароля');
              } finally {
                setPasswordChangeLoading(false);
              }
            }}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  {currentUser?.mustChangePassword
                    ? 'Смена пароля (по желанию)'
                    : 'Смена пароля учётной записи'}
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {currentUser?.mustChangePassword
                    ? 'Вы можете сменить пароль сейчас или оставить текущий и продолжить работу.'
                    : 'Задайте новый надёжный пароль.'}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (currentUser?.mustChangePassword) {
                    try {
                      await apiFetch('/api/v1/auth/skip-password-change', { method: 'POST' });
                    } catch {
                      // ignore
                    }
                    setCurrentUser((prev) => (prev ? { ...prev, mustChangePassword: false } : null));
                    await loadFullState();
                  }
                  setPasswordChangeDismissed(true);
                  setShowChangePasswordModal(false);
                  setSelfPasswordForm({ currentPassword: '', newPassword: '' });
                }}
                className="p-1 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Текущий пароль
              </label>
              <input
                type="password"
                value={selfPasswordForm.currentPassword}
                onChange={(e) =>
                  setSelfPasswordForm((p) => ({ ...p, currentPassword: e.target.value }))
                }
                placeholder="Введите текущий пароль"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Новый пароль (не менее 8 символов)
              </label>
              <input
                type="password"
                value={selfPasswordForm.newPassword}
                onChange={(e) =>
                  setSelfPasswordForm((p) => ({ ...p, newPassword: e.target.value }))
                }
                placeholder="Введите новый пароль"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
                required
              />
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={passwordChangeLoading}
                className="w-full sm:flex-1 py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {passwordChangeLoading ? 'Сохранение...' : 'Сохранить пароль'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (currentUser?.mustChangePassword) {
                    try {
                      await apiFetch('/api/v1/auth/skip-password-change', { method: 'POST' });
                    } catch {
                      // ignore
                    }
                    setCurrentUser((prev) => (prev ? { ...prev, mustChangePassword: false } : null));
                    await loadFullState();
                    notify('success', 'Текущий пароль сохранён. Вы можете сменить его в любое время.');
                  }
                  setPasswordChangeDismissed(true);
                  setShowChangePasswordModal(false);
                  setSelfPasswordForm({ currentPassword: '', newPassword: '' });
                }}
                disabled={passwordChangeLoading}
                className="w-full sm:w-auto px-3.5 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 hover:text-slate-900"
              >
                {currentUser?.mustChangePassword ? 'Оставить текущий' : 'Отмена'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showAuthModal && (
        <AuthGateModal
          onClose={() => setShowAuthModal(false)}
          apiFetch={apiFetch}
          onSuccessLogin={async (loginData) => {
            if (loginData?.user) {
              setCurrentUser(loginData.user);
              setCsrfToken(loginData.csrfToken || '');
              setSessionToken(loginData.sessionToken || '');
              await loadFullState(loginData.csrfToken || '', loginData.sessionToken || '');
            } else {
              await initializeSessionAndData();
            }
            notify('success', 'Выполнена авторизация в защищённой сессии.');
          }}
        />
      )}
    </div>
  );
}
