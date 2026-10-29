export type UserRole = 'owner' | 'staff' | 'readonly';
export type UserStatus = 'active' | 'blocked';
export type RoundingRule = 'kopeck' | 'ruble' | 'ten_rubles';
export type ScheduleType = 'equal' | 'custom';
export type ContractStatus = 'draft' | 'active' | 'completed' | 'restructured' | 'returned' | 'cancelled';
export type ScheduleItemStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'superseded' | 'waived';
export type HandoverStatus = 'in_procurement' | 'ready' | 'handed_over' | 'returned';
export type PaymentMethod = 'cash' | 'bank_transfer';
export type ClientPaymentStatus = 'vip' | 'reliable' | 'watch' | 'complex' | 'closed' | 'new';

export interface StatusRulesConfigDTO {
  gracePeriodDays: number;
  complexMinOverdueDays: number;
  complexConsecutiveMissedCount: number;
  complexMinOverdueKopecks: number;
  reliableMaxPastLateCount: number;
  updatedAt: string;
}
export type LedgerEntryType =
  | 'client_payment'
  | 'purchase_payment'
  | 'delivery_expense'
  | 'operating_expense'
  | 'owner_injection'
  | 'owner_withdrawal'
  | 'internal_transfer_out'
  | 'internal_transfer_in'
  | 'client_refund'
  | 'supplier_refund'
  | 'reversal';

export interface UserDTO {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
}

export interface InstallmentPlanDTO {
  id: string;
  name: string;
  termMonths: number;
  markupPercent: number;
  downPaymentPercent: number;
  downPaymentRequired: boolean;
  roundingRule: RoundingRule;
  earlyPayoffDiscountPercent: number;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

export interface SettingHistoryDTO {
  id: string;
  settingType: string;
  entityId: string;
  oldValueJson: string;
  newValueJson: string;
  reason: string;
  changedByEmail: string;
  createdAt: string;
}

export interface ClientDTO {
  id: string;
  fullName: string;
  phone: string;
  secondaryPhone: string;
  documentRef: string;
  address: string;
  notes: string;
  status: 'active' | 'archived';
  createdAt: string;
  activeContractsCount: number;
  completedContractsCount?: number;
  totalDebtKopecks: number;
  overdueDebtKopecks: number;
  totalRemainingDebtKopecks?: number;
  totalOverdueKopecks?: number;
  nextPaymentDate?: string | null;
  nextPaymentAmountKopecks?: number;
  maxDaysOverdue?: number;
  consecutiveOverdueCount?: number;
  paymentStatus?: ClientPaymentStatus;
  paymentStatusLabel?: string;
  paymentStatusReason?: string;
}

export interface SupplierDTO {
  id: string;
  name: string;
  category: string;
  contactInfo: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  totalPurchasedKopecks: number;
  totalPaidKopecks: number;
  totalDebtKopecks: number;
  purchasesCount: number;
}

export interface PurchaseDTO {
  id: string;
  supplierId: string;
  supplierName: string;
  clientId: string | null;
  clientName: string | null;
  itemName: string;
  itemCategory: string;
  quantity: number;
  purchasePriceKopecks: number;
  deliveryCostKopecks: number;
  otherCostKopecks: number;
  totalCostKopecks: number;
  paidToSupplierKopecks: number;
  supplierDebtKopecks: number;
  handoverStatus: HandoverStatus;
  purchaseDate: string;
  notes: string;
  contractId: string | null;
  contractNumber: string | null;
  createdAt: string;
}

export interface ScheduleItemDTO {
  id: string;
  contractId: string;
  scheduleVersion: number;
  installmentNumber: number;
  dueDate: string;
  originalDueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  remainingKopecks: number;
  status: ScheduleItemStatus;
  daysOverdue: number;
  promisedDate: string | null;
  postponeReason: string;
}

export interface ScheduleVersionDTO {
  id: string;
  contractId: string;
  version: number;
  changeReason: string;
  createdByEmail: string;
  createdAt: string;
  items: ScheduleItemDTO[];
}

export interface ContractDTO {
  id: string;
  contractNumber: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  purchaseId: string | null;
  planId: string | null;
  planVersion: number;
  itemTitle: string;
  purchaseCostKopecks: number;
  extraCostKopecks: number;
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
  startDate: string;
  currentScheduleVersion: number;
  status: ContractStatus;
  closingDiscountKopecks: number;
  closedAt: string | null;
  notes: string;
  createdAt: string;
  totalPaidOnScheduleKopecks: number;
  totalCollectedKopecks: number;
  remainingDebtKopecks: number;
  overdueKopecks: number;
  computedStatus?: ClientPaymentStatus;
  computedStatusLabel?: string;
  computedStatusReason?: string;
  contractStatus?: ClientPaymentStatus;
  contractStatusLabel?: string;
  contractStatusReason?: string;
  schedule: ScheduleItemDTO[];
  scheduleHistory: ScheduleVersionDTO[];
}

export interface PaymentAllocationDTO {
  id: string;
  paymentId: string;
  contractId: string;
  contractNumber: string;
  scheduleItemId: string;
  installmentNumber: number;
  dueDate: string;
  amountKopecks: number;
  status: 'active' | 'reversed';
  createdAt: string;
}

export interface PaymentDTO {
  id: string;
  idempotencyKey: string;
  clientId: string;
  clientName: string;
  contractId: string | null;
  contractNumber: string | null;
  accountId: string;
  accountName: string;
  paymentMethod: PaymentMethod;
  amountKopecks: number;
  allocatedKopecks: number;
  unallocatedKopecks: number;
  isDownPayment: boolean;
  status: 'confirmed' | 'reversed';
  reversalReason: string;
  eventDate: string;
  notes: string;
  createdByEmail: string;
  createdAt: string;
  allocations: PaymentAllocationDTO[];
}

export interface FinancialAccountDTO {
  id: string;
  name: string;
  accountType: 'cash' | 'bank';
  balanceKopecks: number;
  isActive: boolean;
}

export interface LedgerEntryDTO {
  id: string;
  idempotencyKey: string;
  accountId: string;
  accountName: string;
  relatedAccountId: string | null;
  entryType: LedgerEntryType;
  category: string;
  direction: 'in' | 'out';
  amountKopecks: number;
  referenceType: string;
  referenceId: string;
  reversalOfId: string | null;
  reversalReason: string;
  description: string;
  eventDate: string;
  status: 'confirmed' | 'reversed';
  createdByEmail: string;
  createdAt: string;
}

export interface OverdueItemDTO {
  scheduleItemId: string;
  contractId: string;
  contractNumber: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  itemTitle: string;
  installmentNumber: number;
  dueDate: string;
  plannedKopecks: number;
  paidKopecks: number;
  overdueKopecks: number;
  daysOverdue: number;
  promisedDate: string | null;
  postponeReason: string;
  contacts: Array<{
    id: string;
    contactChannel: 'phone' | 'messenger' | 'in_person';
    summary: string;
    promisedDate: string | null;
    createdByEmail: string;
    createdAt: string;
  }>;
}

export interface DocumentDTO {
  id: string;
  entityType: 'client' | 'contract' | 'purchase' | 'payment' | 'return';
  entityId: string;
  clientId?: string | null;
  contractId?: string | null;
  docCategory: 'contract_scan' | 'receipt' | 'transfer_proof' | 'handover_act' | 'return_act' | 'photo' | 'generated_template';
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hash: string;
  previousDocumentId?: string | null;
  replacedById?: string | null;
  isArchived?: boolean;
  createdByEmail: string;
  createdAt: string;
}

export interface BackupDTO {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256Hash: string;
  encryptedAlg: string;
  contractsCount: number;
  ledgerNetKopecks: number;
  verifiedRestoreAt: string | null;
  status: 'created' | 'verified' | 'failed';
  createdByEmail: string;
  createdAt: string;
}

export interface AuditLogDTO {
  id: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadataJson: string;
  createdAt: string;
}

export interface ReconciliationResultDTO {
  isHealthy: boolean;
  checkedAt: string;
  accountsConsistent: boolean;
  paymentsConsistent: boolean;
  schedulesConsistent: boolean;
  totalCashAndBankKopecks: number;
  calculatedLedgerBalanceKopecks: number;
  discrepancies: string[];
}
