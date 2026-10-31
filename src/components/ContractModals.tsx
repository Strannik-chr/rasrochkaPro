import React, { useState, useEffect, useMemo } from 'react';
import {
  ClientDTO,
  ContractDTO,
  FinancialAccountDTO,
  InstallmentPlanDTO,
  PurchaseDTO,
  RoundingRule,
  ScheduleType,
} from '../shared/types';
import {
  formatDateRu,
  formatFileSize,
  formatMoney,
  getClientPaymentStatusMeta,
  parseRublesInputToKopecks,
  translateRoundingRule,
  translateScheduleStatus,
} from '../utils/format';
import { normalizePhoneE164 } from '../shared/clientStatus';
import {
  X,
  Calculator,
  Check,
  AlertTriangle,
  Printer,
  History,
  UserPlus,
  UserCheck,
  Search,
  Paperclip,
  Camera,
  FileText,
  Trash2,
  ShieldCheck,
  Edit3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface NewContractModalProps {
  clients: ClientDTO[];
  purchases: PurchaseDTO[];
  plans: InstallmentPlanDTO[];
  accounts: FinancialAccountDTO[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
}

interface PendingContractAttachment {
  id: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
  previewDataUrl?: string;
  guarantorDocType?: string;
}

interface GuarantorDraftItem {
  localId: string;
  mode: 'existing' | 'new';
  clientId: string;
  searchQuery: string;
  showSuggestions: boolean;
  lastName: string;
  firstName: string;
  patronymic: string;
  phone: string;
  secondaryPhone: string;
  documentRef: string;
  address: string;
  notes: string;
  signedGuaranteeReceived: boolean;
  isCollapsed: boolean;
  selectedDocType: string;
  attachments: PendingContractAttachment[];
}

function splitFullNameParts(fullName: string): {
  lastName: string;
  firstName: string;
  patronymic: string;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    patronymic: parts.slice(2).join(' ') || '',
  };
}

function joinFullNameParts(lastName: string, firstName: string, patronymic: string): string {
  return [lastName.trim(), firstName.trim(), patronymic.trim()].filter(Boolean).join(' ');
}

const GUARANTOR_DOC_TYPE_LABELS: Record<string, string> = {
  guarantor_passport: 'Фото / скан паспорта поручителя',
  signed_guarantee: 'Подписанный документ поручительства',
  guarantor_id_scan: 'Скан удостоверения / документа',
  guarantor_extra: 'Дополнительный документ поручителя',
};

export const NewContractModal: React.FC<NewContractModalProps> = ({
  clients,
  purchases,
  plans,
  accounts,
  onClose,
  onSubmit,
  apiFetch,
}) => {
  const activePlans = plans.filter((p) => p.isActive);
  const defaultPlan = activePlans[0] || plans[0];

  const [idempotencyKey] = useState(
    () => `idem_contract_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  );

  // Client selection / inline creation state
  const [clientMode, setClientMode] = useState<'existing' | 'new'>(
    clients.length > 0 ? 'existing' : 'new'
  );
  const [clientId, setClientId] = useState(clients[0]?.id || '');
  const [clientNameQuery, setClientNameQuery] = useState(clients[0]?.fullName || '');
  const initialNameParts = splitFullNameParts(clients[0]?.fullName || '');
  const [payerLastName, setPayerLastName] = useState(initialNameParts.lastName);
  const [payerFirstName, setPayerFirstName] = useState(initialNameParts.firstName);
  const [payerPatronymic, setPayerPatronymic] = useState(initialNameParts.patronymic);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Inline new client fields & existing client optional supplement fields
  const [newClientPhone, setNewClientPhone] = useState('+7 ');
  const [newClientSecondaryPhone, setNewClientSecondaryPhone] = useState(
    clients[0]?.secondaryPhone || ''
  );
  const [newClientDocumentRef, setNewClientDocumentRef] = useState(
    clients[0]?.documentRef || ''
  );
  const [newClientAddress, setNewClientAddress] = useState(clients[0]?.address || '');
  const [newClientNotes, setNewClientNotes] = useState('');
  const [allowSimilarName, setAllowSimilarName] = useState(false);

  // Guarantors state (0, 1, 2, 3, or more)
  const [guarantors, setGuarantors] = useState<GuarantorDraftItem[]>([]);

  // Contract attachments state (JPEG, PNG, WebP, PDF)
  const [attachments, setAttachments] = useState<PendingContractAttachment[]>([]);

  const [purchaseId, setPurchaseId] = useState<string>('');
  const [planId, setPlanId] = useState<string>(defaultPlan?.id || '');
  const [itemTitle, setItemTitle] = useState('');
  const [purchaseRubles, setPurchaseRubles] = useState('50000');
  const [deliveryRubles, setDeliveryRubles] = useState('1000');
  const [otherRubles, setOtherRubles] = useState('0');
  const [markupPercent, setMarkupPercent] = useState(String(defaultPlan?.markupPercent ?? 25));
  const [downPaymentPercent, setDownPaymentPercent] = useState(
    String(defaultPlan?.downPaymentPercent ?? 30)
  );
  const [termMonths, setTermMonths] = useState(String(defaultPlan?.termMonths ?? 6));
  const [roundingRule, setRoundingRule] = useState<RoundingRule>(
    defaultPlan?.roundingRule || 'kopeck'
  );
  const [scheduleType, setScheduleType] = useState<ScheduleType>('equal');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [collectDownPaymentNow, setCollectDownPaymentNow] = useState(true);
  const [downPaymentAccountId, setDownPaymentAccountId] = useState(accounts[0]?.id || 'acc_cash_main');
  const [downPaymentMethod, setDownPaymentMethod] = useState<'cash' | 'bank_transfer'>('cash');
  const [notes, setNotes] = useState('');

  const [previewResult, setPreviewResult] = useState<any | null>(null);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedExistingClient = useMemo(
    () => clients.find((c) => c.id === clientId) || null,
    [clients, clientId]
  );

  // Live autocomplete matches by ФИО or phone
  const matchingClients = useMemo(() => {
    const q = clientNameQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    if (!q) return clients.slice(0, 8);
    return clients
      .filter((c) => {
        const nameMatch = c.fullName.toLowerCase().includes(q);
        const phoneMatch =
          c.phone.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits));
        return nameMatch || phoneMatch;
      })
      .slice(0, 8);
  }, [clients, clientNameQuery]);

  // Duplicate detection when creating a new client
  const duplicateCheck = useMemo(() => {
    if (clientMode !== 'new') {
      return { exactPhoneDuplicate: null as ClientDTO | null, similarNameClients: [] as ClientDTO[] };
    }
    const normalizedPhone = normalizePhoneE164(newClientPhone);
    const exactPhoneDuplicate = normalizedPhone
      ? clients.find(
          (c) =>
            normalizePhoneE164(c.phone) === normalizedPhone ||
            (c.secondaryPhone && normalizePhoneE164(c.secondaryPhone) === normalizedPhone)
        ) || null
      : null;

    const rawName = clientNameQuery.trim().toLowerCase();
    const tokens = rawName.split(/\s+/).filter((t) => t.length >= 2);
    const similarNameClients =
      tokens.length > 0
        ? clients.filter((c) => {
            if (exactPhoneDuplicate && c.id === exactPhoneDuplicate.id) return false;
            const cName = c.fullName.toLowerCase();
            if (cName === rawName) return true;
            const matched = tokens.filter((tok) => cName.includes(tok));
            return matched.length >= Math.min(2, tokens.length);
          })
        : [];

    return { exactPhoneDuplicate, similarNameClients };
  }, [clientMode, newClientPhone, clientNameQuery, clients]);

  const handleSelectExistingClient = (cl: ClientDTO) => {
    setClientMode('existing');
    setClientId(cl.id);
    setClientNameQuery(cl.fullName);
    const parts = splitFullNameParts(cl.fullName);
    setPayerLastName(parts.lastName);
    setPayerFirstName(parts.firstName);
    setPayerPatronymic(parts.patronymic);
    setNewClientSecondaryPhone(cl.secondaryPhone || '');
    setNewClientDocumentRef(cl.documentRef || '');
    setNewClientAddress(cl.address || '');
    setShowSuggestions(false);
    setError(null);
  };

  const handleSwitchToNewClient = () => {
    setClientMode('new');
    setClientId('');
    const parts = splitFullNameParts(clientNameQuery);
    setPayerLastName(parts.lastName);
    setPayerFirstName(parts.firstName);
    setPayerPatronymic(parts.patronymic);
    setNewClientSecondaryPhone('');
    setNewClientDocumentRef('');
    setNewClientAddress('');
    setShowSuggestions(false);
    setAllowSimilarName(false);
    setError(null);
  };

  const handlePayerPartsChange = (last: string, first: string, patr: string) => {
    setPayerLastName(last);
    setPayerFirstName(first);
    setPayerPatronymic(patr);
    setClientNameQuery(joinFullNameParts(last, first, patr));
  };

  // --- GUARANTORS HELPERS ---
  const handleAddGuarantor = () => {
    setError(null);
    if (guarantors.length >= 15) {
      setError('Достигнуто максимальное количество поручителей по одному договору (15).');
      return;
    }
    setGuarantors((prev) => [
      ...prev,
      {
        localId: `guar_draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        mode: 'new',
        clientId: '',
        searchQuery: '',
        showSuggestions: false,
        lastName: '',
        firstName: '',
        patronymic: '',
        phone: '+7 ',
        secondaryPhone: '',
        documentRef: '',
        address: '',
        notes: '',
        signedGuaranteeReceived: false,
        isCollapsed: false,
        selectedDocType: 'guarantor_passport',
        attachments: [],
      },
    ]);
  };

  const updateGuarantorItem = (
    localId: string,
    updater: (item: GuarantorDraftItem) => GuarantorDraftItem
  ) => {
    setGuarantors((prev) => prev.map((g) => (g.localId === localId ? updater(g) : g)));
  };

  const handleRemoveGuarantor = (localId: string) => {
    setGuarantors((prev) => prev.filter((g) => g.localId !== localId));
    setError(null);
  };

  const handleSelectExistingGuarantor = (localId: string, cl: ClientDTO) => {
    const parts = splitFullNameParts(cl.fullName);
    updateGuarantorItem(localId, (g) => ({
      ...g,
      mode: 'existing',
      clientId: cl.id,
      searchQuery: cl.fullName,
      showSuggestions: false,
      lastName: parts.lastName,
      firstName: parts.firstName,
      patronymic: parts.patronymic,
      phone: cl.phone,
      secondaryPhone: cl.secondaryPhone || '',
      documentRef: cl.documentRef || '',
      address: cl.address || '',
    }));
    setError(null);
  };

  const handleGuarantorFilesSelected = async (
    localId: string,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setError(null);

    const targetGuarantor = guarantors.find((g) => g.localId === localId);
    const docTypeKey = targetGuarantor?.selectedDocType || 'guarantor_passport';
    const docTypeLabel = GUARANTOR_DOC_TYPE_LABELS[docTypeKey] || 'Документ поручителя';

    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
    const newItems: PendingContractAttachment[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        setError(
          `Файл «${file.name}» не поддерживается. Разрешены форматы: JPEG, PNG, WebP и PDF.`
        );
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(`Файл «${file.name}» превышает максимальный размер 10 МБ.`);
        continue;
      }

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
      });

      const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      newItems.push({
        id: `gatt_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        title: `${docTypeLabel} (${file.name})`,
        originalFilename: file.name,
        mimeType:
          file.type ||
          (ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`),
        sizeBytes: file.size,
        contentBase64: base64Part,
        previewDataUrl: file.type.startsWith('image/') ? dataUrl : undefined,
        guarantorDocType: docTypeKey,
      });
    }

    if (newItems.length > 0) {
      updateGuarantorItem(localId, (g) => ({
        ...g,
        signedGuaranteeReceived:
          docTypeKey === 'signed_guarantee' ? true : g.signedGuaranteeReceived,
        attachments: [...g.attachments, ...newItems],
      }));
    }
    e.target.value = '';
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setError(null);

    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
    const newItems: PendingContractAttachment[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        setError(
          `Файл «${file.name}» не поддерживается. Разрешены форматы: JPEG, PNG, WebP и PDF.`
        );
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(`Файл «${file.name}» превышает максимальный размер 10 МБ.`);
        continue;
      }

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
      });

      const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      newItems.push({
        id: `att_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        title: `Скан/фото договора (${file.name})`,
        originalFilename: file.name,
        mimeType: file.type || (ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`),
        sizeBytes: file.size,
        contentBase64: base64Part,
        previewDataUrl: file.type.startsWith('image/') ? dataUrl : undefined,
      });
    }

    if (newItems.length > 0) {
      setAttachments((prev) => [...prev, ...newItems]);
    }
    e.target.value = '';
  };

  const handleSelectPlan = (selectedId: string) => {
    setPlanId(selectedId);
    setPreviewConfirmed(false);
    const found = plans.find((p) => p.id === selectedId);
    if (found) {
      setMarkupPercent(String(found.markupPercent));
      setDownPaymentPercent(String(found.downPaymentPercent));
      setTermMonths(String(found.termMonths));
      setRoundingRule(found.roundingRule);
    }
  };

  const handleSelectPurchase = (purId: string) => {
    setPurchaseId(purId);
    setPreviewConfirmed(false);
    const found = purchases.find((p) => p.id === purId);
    if (found) {
      setItemTitle(found.itemName);
      setPurchaseRubles(String(found.purchasePriceKopecks / 100));
      setDeliveryRubles(String(found.deliveryCostKopecks / 100));
      setOtherRubles(String(found.otherCostKopecks / 100));
      if (found.clientId) {
        const cl = clients.find((c) => c.id === found.clientId);
        if (cl) {
          handleSelectExistingClient(cl);
        }
      }
    }
  };

  const runPreviewCalculation = async () => {
    setError(null);
    setPreviewConfirmed(false);
    try {
      const data = await apiFetch('/api/v1/contracts/preview', {
        method: 'POST',
        body: JSON.stringify({
          purchaseCostKopecks: parseRublesInputToKopecks(purchaseRubles),
          deliveryCostKopecks: parseRublesInputToKopecks(deliveryRubles),
          otherCostKopecks: parseRublesInputToKopecks(otherRubles),
          markupPercent: Number(markupPercent),
          downPaymentPercent: Number(downPaymentPercent),
          termMonths: Number(termMonths),
          roundingRule,
          scheduleType,
          startDate,
        }),
      });
      setPreviewResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка расчёта');
    }
  };

  useEffect(() => {
    runPreviewCalculation();
  }, [
    purchaseRubles,
    deliveryRubles,
    otherRubles,
    markupPercent,
    downPaymentPercent,
    termMonths,
    roundingRule,
    startDate,
  ]);

  const primaryEffectivePhone = useMemo(() => {
    if (clientMode === 'existing' && selectedExistingClient) {
      return normalizePhoneE164(selectedExistingClient.phone) || '';
    }
    return normalizePhoneE164(newClientPhone) || '';
  }, [clientMode, selectedExistingClient, newClientPhone]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewConfirmed) {
      setError('Необходимо проверить и подтвердить расчёт и график платежей перед активацией договора.');
      return;
    }

    if (clientMode === 'existing' && !clientId) {
      setError('Выберите существующего клиента из списка совпадений или переключитесь на создание нового клиента.');
      return;
    }

    if (clientMode === 'new') {
      const composedPayerName =
        joinFullNameParts(payerLastName, payerFirstName, payerPatronymic) ||
        clientNameQuery.trim();
      if (!composedPayerName) {
        setError('Введите ФИО основного плательщика (фамилию, имя и отчество).');
        return;
      }
      const normPhone = normalizePhoneE164(newClientPhone);
      if (!normPhone) {
        setError('Введите корректный номер телефона основного плательщика в формате +7XXXXXXXXXX.');
        return;
      }
      if (duplicateCheck.exactPhoneDuplicate) {
        setError(
          `Клиент с номером ${normPhone} уже существует («${duplicateCheck.exactPhoneDuplicate.fullName}»). Выберите его, чтобы не создавать дубликат.`
        );
        return;
      }
    }

    // Validate guarantors before submitting
    const seenGuarantorClientIds = new Set<string>();
    const seenGuarantorPhones = new Set<string>();

    for (let i = 0; i < guarantors.length; i++) {
      const g = guarantors[i];
      const label = `Поручитель №${i + 1}`;
      if (g.mode === 'existing') {
        if (!g.clientId) {
          setError(`${label}: выберите человека из базы или переключитесь на создание новой карточки поручителя.`);
          return;
        }
        if (clientMode === 'existing' && g.clientId === clientId) {
          setError(`${label}: основной плательщик не может быть поручителем по собственному договору.`);
          return;
        }
        if (seenGuarantorClientIds.has(g.clientId)) {
          setError(`${label}: этот человек уже добавлен поручителем в текущий договор.`);
          return;
        }
        seenGuarantorClientIds.add(g.clientId);
      } else {
        const gFullName =
          joinFullNameParts(g.lastName, g.firstName, g.patronymic) || g.searchQuery.trim();
        if (!gFullName) {
          setError(`${label}: заполните ФИО поручителя (Фамилию и Имя).`);
          return;
        }
        const gNormPhone = normalizePhoneE164(g.phone);
        if (!gNormPhone) {
          setError(`${label} («${gFullName}»): укажите корректный основной номер телефона (+7XXXXXXXXXX).`);
          return;
        }
        if (primaryEffectivePhone && gNormPhone === primaryEffectivePhone) {
          setError(
            `${label} («${gFullName}»): телефон совпадает с основным плательщиком. Основной плательщик не может быть поручителем по собственному договору.`
          );
          return;
        }
        if (seenGuarantorPhones.has(gNormPhone)) {
          setError(`${label} («${gFullName}»): этот номер телефона (${gNormPhone}) уже указан у другого поручителя в этом договоре.`);
          return;
        }
        const existingMatch = clients.find(
          (c) =>
            normalizePhoneE164(c.phone) === gNormPhone ||
            (c.secondaryPhone && normalizePhoneE164(c.secondaryPhone) === gNormPhone)
        );
        if (existingMatch) {
          setError(
            `${label}: человек с номером ${gNormPhone} уже есть в базе («${existingMatch.fullName}»). Нажмите «Выбрать существующего» в карточке поручителя, чтобы не создавать дубликат.`
          );
          return;
        }
        seenGuarantorPhones.add(gNormPhone);
      }
    }

    const composedPayerFullName =
      joinFullNameParts(payerLastName, payerFirstName, payerPatronymic) ||
      clientNameQuery.trim();

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        idempotencyKey,
        clientId: clientMode === 'existing' ? clientId : undefined,
        clientUpdates:
          clientMode === 'existing'
            ? {
                secondaryPhone: newClientSecondaryPhone.trim(),
                documentRef: newClientDocumentRef.trim(),
                address: newClientAddress.trim(),
              }
            : undefined,
        newClient:
          clientMode === 'new'
            ? {
                fullName: composedPayerFullName,
                lastName: payerLastName.trim(),
                firstName: payerFirstName.trim(),
                patronymic: payerPatronymic.trim(),
                phone: newClientPhone.trim(),
                secondaryPhone: newClientSecondaryPhone.trim(),
                documentRef: newClientDocumentRef.trim(),
                address: newClientAddress.trim(),
                notes: newClientNotes.trim(),
                allowSimilarName,
              }
            : undefined,
        guarantors: guarantors.map((g) => {
          const fullName =
            joinFullNameParts(g.lastName, g.firstName, g.patronymic) || g.searchQuery.trim();
          return {
            clientId: g.mode === 'existing' ? g.clientId : undefined,
            clientUpdates:
              g.mode === 'existing'
                ? {
                    secondaryPhone: g.secondaryPhone.trim(),
                    documentRef: g.documentRef.trim(),
                    address: g.address.trim(),
                  }
                : undefined,
            newClient:
              g.mode === 'new'
                ? {
                    fullName,
                    lastName: g.lastName.trim(),
                    firstName: g.firstName.trim(),
                    patronymic: g.patronymic.trim(),
                    phone: g.phone.trim(),
                    secondaryPhone: g.secondaryPhone.trim(),
                    documentRef: g.documentRef.trim(),
                    address: g.address.trim(),
                    notes: g.notes.trim(),
                  }
                : undefined,
            notes: g.notes.trim(),
            signedGuaranteeReceived: g.signedGuaranteeReceived,
            attachments: g.attachments.map((att) => ({
              title: att.title,
              originalFilename: att.originalFilename,
              mimeType: att.mimeType,
              contentBase64: att.contentBase64,
              guarantorDocType: att.guarantorDocType || 'guarantor_passport',
            })),
          };
        }),
        purchaseId: purchaseId || null,
        planId: planId || null,
        itemTitle,
        purchaseCostKopecks: parseRublesInputToKopecks(purchaseRubles),
        deliveryCostKopecks: parseRublesInputToKopecks(deliveryRubles),
        otherCostKopecks: parseRublesInputToKopecks(otherRubles),
        markupPercent: Number(markupPercent),
        downPaymentPercent: Number(downPaymentPercent),
        termMonths: Number(termMonths),
        roundingRule,
        scheduleType,
        startDate,
        collectDownPaymentNow,
        downPaymentAccountId,
        downPaymentMethod,
        confirmedCalculation: previewConfirmed,
        notes,
        attachments: attachments.map((att) => ({
          title: att.title,
          originalFilename: att.originalFilename,
          mimeType: att.mimeType,
          contentBase64: att.contentBase64,
          docCategory: 'contract_scan',
        })),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания договора');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 break-words">
              Оформление договора продажи в рассрочку
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 break-words">
              Заполните данные основного плательщика, добавьте одного или нескольких поручителей (при необходимости) и прикрепите документы
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleCreate} className="mt-5 space-y-6">
          {/* 1. Primary Payer Block (ОСНОВНОЙ ПЛАТЕЛЬЩИК) */}
          <div className="p-4 border border-slate-200 rounded-xl bg-slate-50/60 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-slate-700" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    1. ОСНОВНОЙ ПЛАТЕЛЬЩИК ПО ДОГОВОРУ *
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Найдите существующего клиента по ФИО или телефону либо создайте новую карточку прямо в форме
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setClientMode('existing');
                    if (!clientId && clients[0]) {
                      handleSelectExistingClient(clients[0]);
                    }
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border flex items-center gap-1 ${
                    clientMode === 'existing'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <UserCheck className="w-3.5 h-3.5" />
                  <span>Выбрать из базы ({clients.length})</span>
                </button>
                <button
                  type="button"
                  onClick={handleSwitchToNewClient}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border flex items-center gap-1 ${
                    clientMode === 'new'
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>+ Новый клиент в договоре</span>
                </button>
              </div>
            </div>

            <div className="relative">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Поиск клиента по ФИО или номеру телефона *
              </label>
              <input
                type="text"
                value={clientNameQuery}
                onFocus={() => setShowSuggestions(true)}
                onChange={(e) => {
                  const val = e.target.value;
                  setClientNameQuery(val);
                  const parts = splitFullNameParts(val);
                  setPayerLastName(parts.lastName);
                  setPayerFirstName(parts.firstName);
                  setPayerPatronymic(parts.patronymic);
                  setShowSuggestions(true);
                  if (clientMode === 'existing') {
                    const exact = clients.find(
                      (c) => c.fullName.toLowerCase() === val.trim().toLowerCase()
                    );
                    if (exact) {
                      setClientId(exact.id);
                    } else {
                      setClientId('');
                    }
                  }
                }}
                placeholder="Начните вводить фамилию, имя, отчество или телефон клиента..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                required
              />

              {/* Autocomplete dropdown */}
              {showSuggestions && clientNameQuery.trim().length > 0 && (
                <div className="mt-1 border border-slate-200 rounded-lg bg-white shadow-sm max-h-52 overflow-y-auto divide-y divide-slate-100">
                  {matchingClients.length > 0 ? (
                    matchingClients.map((cl) => {
                      const stMeta = getClientPaymentStatusMeta(cl.paymentStatus);
                      const isSelected = clientMode === 'existing' && clientId === cl.id;
                      return (
                        <div
                          key={cl.id}
                          onClick={() => handleSelectExistingClient(cl)}
                          className={`px-3 py-2 text-xs flex items-center justify-between cursor-pointer hover:bg-slate-50 ${
                            isSelected ? 'bg-emerald-50/70' : ''
                          }`}
                        >
                          <div>
                            <div className="font-medium text-slate-900 flex items-center gap-2">
                              <span>{cl.fullName}</span>
                              <span
                                className={`px-2 py-0.5 text-[10px] font-medium border rounded-md ${stMeta.badgeClass}`}
                              >
                                {stMeta.label}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                              Тел: {cl.phone}
                              {cl.documentRef ? ` · Паспорт: ${cl.documentRef}` : ''}
                              {typeof cl.activeContractsCount === 'number'
                                ? ` · Активных договоров: ${cl.activeContractsCount}`
                                : ''}
                            </div>
                          </div>
                          <span className="text-[11px] font-medium text-emerald-700">
                            {isSelected ? 'Выбран ✓' : 'Выбрать'}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="p-3 text-xs text-slate-600 flex items-center justify-between">
                      <span>Совпадений по «{clientNameQuery}» в базе не найдено.</span>
                      {clientMode !== 'new' && (
                        <button
                          type="button"
                          onClick={handleSwitchToNewClient}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800"
                        >
                          Создать клиента «{clientNameQuery.trim()}»
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Selected existing client summary + editable supplementary fields */}
            {clientMode === 'existing' && selectedExistingClient && (
              <div className="p-3.5 bg-white border border-slate-200 rounded-lg space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900 flex items-center gap-2">
                      <span>Выбран существующий клиент: {selectedExistingClient.fullName}</span>
                      <span
                        className={`px-2 py-0.5 text-[10px] font-medium border rounded-md ${
                          getClientPaymentStatusMeta(selectedExistingClient.paymentStatus).badgeClass
                        }`}
                      >
                        {getClientPaymentStatusMeta(selectedExistingClient.paymentStatus).label}
                      </span>
                    </div>
                    <div className="text-slate-500 mt-0.5 font-mono">
                      Основной телефон: {selectedExistingClient.phone} · Остаток долга по своим договорам:{' '}
                      {formatMoney(selectedExistingClient.totalRemainingDebtKopecks || 0)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSuggestions((v) => !v)}
                    className="px-2.5 py-1 text-xs text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    Сменить клиента
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-slate-100">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Дополнительный телефон
                    </label>
                    <input
                      type="tel"
                      value={newClientSecondaryPhone}
                      onChange={(e) => setNewClientSecondaryPhone(e.target.value)}
                      placeholder="+7 928 111-22-33"
                      className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Паспортные данные (при необходимости)
                    </label>
                    <input
                      type="text"
                      value={newClientDocumentRef}
                      onChange={(e) => setNewClientDocumentRef(e.target.value)}
                      placeholder="Серия и номер паспорта"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Адрес проживания
                    </label>
                    <input
                      type="text"
                      value={newClientAddress}
                      onChange={(e) => setNewClientAddress(e.target.value)}
                      placeholder="Город, улица, дом"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Inline New Client Form */}
            {clientMode === 'new' && (
              <div className="p-3.5 bg-white border border-emerald-200 rounded-lg space-y-3">
                <div className="text-xs font-semibold text-emerald-900">
                  Регистрация нового основного плательщика одновременно с оформлением договора
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Фамилия *
                    </label>
                    <input
                      type="text"
                      value={payerLastName}
                      onChange={(e) =>
                        handlePayerPartsChange(e.target.value, payerFirstName, payerPatronymic)
                      }
                      placeholder="Фамилия"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Имя *
                    </label>
                    <input
                      type="text"
                      value={payerFirstName}
                      onChange={(e) =>
                        handlePayerPartsChange(payerLastName, e.target.value, payerPatronymic)
                      }
                      placeholder="Имя"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Отчество
                    </label>
                    <input
                      type="text"
                      value={payerPatronymic}
                      onChange={(e) =>
                        handlePayerPartsChange(payerLastName, payerFirstName, e.target.value)
                      }
                      placeholder="Отчество"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Основной номер телефона (WhatsApp / звонки) *
                    </label>
                    <input
                      type="tel"
                      value={newClientPhone}
                      onChange={(e) => setNewClientPhone(e.target.value)}
                      placeholder="+7 928 000-00-00"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      required={clientMode === 'new'}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Дополнительный номер телефона (опционально)
                    </label>
                    <input
                      type="tel"
                      value={newClientSecondaryPhone}
                      onChange={(e) => setNewClientSecondaryPhone(e.target.value)}
                      placeholder="+7 928 111-22-33"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Паспортные данные (при необходимости)
                    </label>
                    <input
                      type="text"
                      value={newClientDocumentRef}
                      onChange={(e) => setNewClientDocumentRef(e.target.value)}
                      placeholder="Серия и номер паспорта"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Адрес проживания
                    </label>
                    <input
                      type="text"
                      value={newClientAddress}
                      onChange={(e) => setNewClientAddress(e.target.value)}
                      placeholder="Город, улица, дом"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                {/* Duplicate phone warning */}
                {duplicateCheck.exactPhoneDuplicate && (
                  <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">
                        Внимание: клиент с этим номером телефона уже есть в базе!
                      </div>
                      <div className="mt-0.5">
                        {duplicateCheck.exactPhoneDuplicate.fullName} (
                        {duplicateCheck.exactPhoneDuplicate.phone})
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        handleSelectExistingClient(duplicateCheck.exactPhoneDuplicate!)
                      }
                      className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                    >
                      Выбрать существующего клиента
                    </button>
                  </div>
                )}

                {/* Similar name warning */}
                {!duplicateCheck.exactPhoneDuplicate &&
                  duplicateCheck.similarNameClients.length > 0 && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-2">
                      <div className="font-semibold">
                        Найдены похожие клиенты по ФИО — проверьте, чтобы не создать дубликат:
                      </div>
                      <div className="space-y-1">
                        {duplicateCheck.similarNameClients.map((sim) => (
                          <div
                            key={sim.id}
                            className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded border border-amber-200"
                          >
                            <span>
                              <strong>{sim.fullName}</strong> · тел. {sim.phone}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleSelectExistingClient(sim)}
                              className="px-2.5 py-1 text-[11px] font-medium text-white bg-slate-900 rounded hover:bg-slate-800"
                            >
                              Выбрать этого клиента
                            </button>
                          </div>
                        ))}
                      </div>
                      <label className="flex items-center gap-2 pt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allowSimilarName}
                          onChange={(e) => setAllowSimilarName(e.target.checked)}
                          className="rounded border-amber-400"
                        />
                        <span>Это другой человек (однофамилец), создать новую карточку</span>
                      </label>
                    </div>
                  )}
              </div>
            )}
          </div>

          {/* 2. New Block: ПОРУЧИТЕЛИ ПО ДОГОВОРУ */}
          <div className="p-4 border border-slate-200 rounded-xl bg-slate-50/60 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-slate-800" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    ПОРУЧИТЕЛИ ПО ДОГОВОРУ ({guarantors.length})
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Добавьте одного или нескольких поручителей, которые участвуют в обеспечении обязательств по договору
                </p>
              </div>
              <button
                type="button"
                onClick={handleAddGuarantor}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center gap-1.5 shadow-xs"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>+ Добавить поручителя</span>
              </button>
            </div>

            {guarantors.length === 0 ? (
              <div className="p-3 bg-white border border-dashed border-slate-300 rounded-lg text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Договор может быть оформлен без поручителей либо с одним, двумя, тремя и более поручителями.
                </span>
                <button
                  type="button"
                  onClick={handleAddGuarantor}
                  className="text-xs font-semibold text-slate-900 underline hover:text-slate-700"
                >
                  + Добавить первого поручителя
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {guarantors.map((g, idx) => {
                  const gFullName =
                    joinFullNameParts(g.lastName, g.firstName, g.patronymic) ||
                    g.searchQuery.trim();
                  const gNormPhone = normalizePhoneE164(g.phone);

                  const isSameAsPayer =
                    (g.mode === 'existing' &&
                      clientMode === 'existing' &&
                      g.clientId &&
                      g.clientId === clientId) ||
                    Boolean(
                      gNormPhone &&
                        primaryEffectivePhone &&
                        gNormPhone === primaryEffectivePhone
                    );

                  const isSameAsOtherGuarantor = guarantors.some((other, otherIdx) => {
                    if (otherIdx === idx) return false;
                    if (
                      g.mode === 'existing' &&
                      other.mode === 'existing' &&
                      g.clientId &&
                      g.clientId === other.clientId
                    ) {
                      return true;
                    }
                    const otherNorm = normalizePhoneE164(other.phone);
                    return Boolean(gNormPhone && otherNorm && gNormPhone === otherNorm);
                  });

                  const duplicateExistingClientForNew =
                    g.mode === 'new' && gNormPhone
                      ? clients.find(
                          (c) =>
                            normalizePhoneE164(c.phone) === gNormPhone ||
                            (c.secondaryPhone &&
                              normalizePhoneE164(c.secondaryPhone) === gNormPhone)
                        ) || null
                      : null;

                  const q = g.searchQuery.trim().toLowerCase();
                  const qDigits = q.replace(/\D/g, '');
                  const guarantorMatches = clients
                    .filter((c) => {
                      if (!q) return true;
                      const nameMatch = c.fullName.toLowerCase().includes(q);
                      const phoneMatch =
                        c.phone.toLowerCase().includes(q) ||
                        (qDigits.length >= 3 &&
                          c.phone.replace(/\D/g, '').includes(qDigits));
                      return nameMatch || phoneMatch;
                    })
                    .slice(0, 7);

                  return (
                    <div
                      key={g.localId}
                      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs"
                    >
                      {/* Guarantor Card Header */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-1 text-xs font-bold bg-slate-900 text-white rounded-md">
                            Поручитель №{idx + 1}
                          </span>
                          <span className="text-xs font-semibold text-slate-900">
                            {gFullName || 'ФИО ещё не заполнено'}
                          </span>
                          {g.phone && g.phone.trim() !== '+7' && (
                            <span className="text-xs font-mono text-slate-500">
                              · {g.phone}
                            </span>
                          )}
                          {g.mode === 'existing' && g.clientId && (
                            <span className="px-2 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">
                              Из базы клиентов
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              updateGuarantorItem(g.localId, (item) => ({
                                ...item,
                                isCollapsed: !item.isCollapsed,
                              }))
                            }
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1"
                          >
                            {g.isCollapsed ? (
                              <>
                                <Edit3 className="w-3.5 h-3.5" />
                                <span>Редактировать</span>
                                <ChevronDown className="w-3.5 h-3.5" />
                              </>
                            ) : (
                              <>
                                <span>Свернуть</span>
                                <ChevronUp className="w-3.5 h-3.5" />
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveGuarantor(g.localId)}
                            className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg flex items-center gap-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Удалить</span>
                          </button>
                        </div>
                      </div>

                      {/* Collapsed Summary View */}
                      {g.isCollapsed ? (
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs text-slate-600 pt-1">
                          <div>
                            <span className="text-slate-400">ФИО:</span>{' '}
                            <strong className="text-slate-900">{gFullName || '—'}</strong>
                          </div>
                          <div>
                            <span className="text-slate-400">Телефон:</span>{' '}
                            <span className="font-mono text-slate-900">{g.phone || '—'}</span>
                          </div>
                          <div>
                            <span className="text-slate-400">Паспорт:</span>{' '}
                            <span className="text-slate-900">{g.documentRef || 'не указан'}</span>
                          </div>
                          <div>
                            <span className="text-slate-400">Адрес / Документы:</span>{' '}
                            <span className="text-slate-900">
                              {g.address || 'не указан'} ({g.attachments.length} файл.)
                            </span>
                          </div>
                        </div>
                      ) : (
                        /* Expanded Guarantor Form */
                        <div className="space-y-3.5">
                          {/* Mode switch + Database Search */}
                          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                            <span className="text-xs font-medium text-slate-700">
                              Способ заполнения поручителя №{idx + 1}:
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  updateGuarantorItem(g.localId, (item) => ({
                                    ...item,
                                    mode: 'existing',
                                    showSuggestions: true,
                                  }))
                                }
                                className={`px-2.5 py-1 text-xs font-medium rounded-md border flex items-center gap-1 ${
                                  g.mode === 'existing'
                                    ? 'bg-slate-900 text-white border-slate-900'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                                <span>Найти и выбрать из базы</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  updateGuarantorItem(g.localId, (item) => ({
                                    ...item,
                                    mode: 'new',
                                    clientId: '',
                                    showSuggestions: false,
                                  }))
                                }
                                className={`px-2.5 py-1 text-xs font-medium rounded-md border flex items-center gap-1 ${
                                  g.mode === 'new'
                                    ? 'bg-emerald-700 text-white border-emerald-700'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                <UserPlus className="w-3.5 h-3.5" />
                                <span>Создать новую карточку</span>
                              </button>
                            </div>
                          </div>

                          {/* Search input for finding existing person by ФИО or phone */}
                          <div className="relative">
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Поиск поручителя в базе по ФИО или номеру телефона
                            </label>
                            <input
                              type="text"
                              value={g.searchQuery}
                              onFocus={() =>
                                updateGuarantorItem(g.localId, (item) => ({
                                  ...item,
                                  showSuggestions: true,
                                }))
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                const parts = splitFullNameParts(val);
                                updateGuarantorItem(g.localId, (item) => ({
                                  ...item,
                                  searchQuery: val,
                                  showSuggestions: true,
                                  lastName:
                                    item.mode === 'new' ? parts.lastName : item.lastName,
                                  firstName:
                                    item.mode === 'new' ? parts.firstName : item.firstName,
                                  patronymic:
                                    item.mode === 'new' ? parts.patronymic : item.patronymic,
                                }));
                              }}
                              placeholder="Введите фамилию, имя, отчество или телефон для быстрого поиска..."
                              className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                            />

                            {g.showSuggestions && (
                              <div className="mt-1 border border-slate-200 rounded-lg bg-white shadow-sm max-h-44 overflow-y-auto divide-y divide-slate-100">
                                {guarantorMatches.length > 0 ? (
                                  guarantorMatches.map((cl) => {
                                    const isPrimaryPayer =
                                      clientMode === 'existing' && cl.id === clientId;
                                    const isSelectedHere =
                                      g.mode === 'existing' && g.clientId === cl.id;
                                    return (
                                      <div
                                        key={cl.id}
                                        onClick={() => {
                                          if (!isPrimaryPayer) {
                                            handleSelectExistingGuarantor(g.localId, cl);
                                          }
                                        }}
                                        className={`px-3 py-2 text-xs flex items-center justify-between ${
                                          isPrimaryPayer
                                            ? 'bg-slate-50 opacity-60 cursor-not-allowed'
                                            : 'cursor-pointer hover:bg-slate-50'
                                        } ${isSelectedHere ? 'bg-emerald-50/70' : ''}`}
                                      >
                                        <div>
                                          <div className="font-medium text-slate-900">
                                            {cl.fullName}
                                          </div>
                                          <div className="text-[11px] text-slate-500 font-mono">
                                            Тел: {cl.phone}
                                            {cl.documentRef
                                              ? ` · Паспорт: ${cl.documentRef}`
                                              : ''}
                                          </div>
                                        </div>
                                        <span className="text-[11px] font-medium text-emerald-700">
                                          {isPrimaryPayer
                                            ? 'Основной плательщик'
                                            : isSelectedHere
                                              ? 'Выбран ✓'
                                              : 'Выбрать поручителем'}
                                        </span>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <div className="p-2.5 text-xs text-slate-500 flex items-center justify-between">
                                    <span>В базе не найдено «{g.searchQuery}».</span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateGuarantorItem(g.localId, (item) => ({
                                          ...item,
                                          mode: 'new',
                                          clientId: '',
                                          showSuggestions: false,
                                        }))
                                      }
                                      className="px-2 py-1 text-[11px] font-medium text-white bg-emerald-700 rounded"
                                    >
                                      Заполнить как нового
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Основная информация */}
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                              Основная информация поручителя
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Фамилия *
                                </label>
                                <input
                                  type="text"
                                  value={g.lastName}
                                  disabled={g.mode === 'existing' && Boolean(g.clientId)}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      lastName: val,
                                      searchQuery: joinFullNameParts(
                                        val,
                                        item.firstName,
                                        item.patronymic
                                      ),
                                    }));
                                  }}
                                  placeholder="Фамилия"
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg disabled:bg-slate-100"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Имя *
                                </label>
                                <input
                                  type="text"
                                  value={g.firstName}
                                  disabled={g.mode === 'existing' && Boolean(g.clientId)}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      firstName: val,
                                      searchQuery: joinFullNameParts(
                                        item.lastName,
                                        val,
                                        item.patronymic
                                      ),
                                    }));
                                  }}
                                  placeholder="Имя"
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg disabled:bg-slate-100"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Отчество
                                </label>
                                <input
                                  type="text"
                                  value={g.patronymic}
                                  disabled={g.mode === 'existing' && Boolean(g.clientId)}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      patronymic: val,
                                      searchQuery: joinFullNameParts(
                                        item.lastName,
                                        item.firstName,
                                        val
                                      ),
                                    }));
                                  }}
                                  placeholder="Отчество"
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg disabled:bg-slate-100"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-2.5">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Основной номер телефона *
                                </label>
                                <input
                                  type="tel"
                                  value={g.phone}
                                  disabled={g.mode === 'existing' && Boolean(g.clientId)}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      phone: e.target.value,
                                    }))
                                  }
                                  placeholder="+7 928 000-00-00"
                                  className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Дополнительный номер телефона (необязательно)
                                </label>
                                <input
                                  type="tel"
                                  value={g.secondaryPhone}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      secondaryPhone: e.target.value,
                                    }))
                                  }
                                  placeholder="+7 928 111-22-33"
                                  className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                                />
                              </div>
                            </div>
                          </div>

                          {/* Дополнительные сведения */}
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                              Дополнительные сведения
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Паспортные данные
                                </label>
                                <input
                                  type="text"
                                  value={g.documentRef}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      documentRef: e.target.value,
                                    }))
                                  }
                                  placeholder="Серия и номер паспорта"
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Адрес проживания
                                </label>
                                <input
                                  type="text"
                                  value={g.address}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      address: e.target.value,
                                    }))
                                  }
                                  placeholder="Город, улица, дом, кв."
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Примечание (необязательно)
                                </label>
                                <input
                                  type="text"
                                  value={g.notes}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      notes: e.target.value,
                                    }))
                                  }
                                  placeholder="Родство, место работы и т.д."
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                                />
                              </div>
                            </div>
                          </div>

                          {/* Validation alerts inside guarantor card */}
                          {isSameAsPayer && (
                            <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium">
                              Ошибка: основной плательщик не может быть добавлен поручителем по собственному договору.
                            </div>
                          )}

                          {isSameAsOtherGuarantor && (
                            <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 font-medium">
                              Ошибка: этот человек уже добавлен поручителем в текущий договор.
                            </div>
                          )}

                          {duplicateExistingClientForNew && (
                            <div className="p-2.5 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <strong>Человек с телефоном {gNormPhone} уже есть в базе:</strong>{' '}
                                {duplicateExistingClientForNew.fullName}
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  handleSelectExistingGuarantor(
                                    g.localId,
                                    duplicateExistingClientForNew
                                  )
                                }
                                className="px-2.5 py-1 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800"
                              >
                                Выбрать существующего
                              </button>
                            </div>
                          )}

                          {/* Документы поручителя */}
                          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-xs font-semibold text-slate-900">
                                  Документы поручителя №{idx + 1} (приватное хранилище)
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  Фото паспорта, скан документа, подписанное поручительство (JPEG, PNG, WebP, PDF до 10 МБ)
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={g.selectedDocType}
                                  onChange={(e) =>
                                    updateGuarantorItem(g.localId, (item) => ({
                                      ...item,
                                      selectedDocType: e.target.value,
                                    }))
                                  }
                                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                                >
                                  <option value="guarantor_passport">Фото / скан паспорта</option>
                                  <option value="signed_guarantee">
                                    Подписанный документ поручительства
                                  </option>
                                  <option value="guarantor_id_scan">Скан документа</option>
                                  <option value="guarantor_extra">Дополнительный документ</option>
                                </select>

                                <label className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer flex items-center gap-1">
                                  <Paperclip className="w-3.5 h-3.5" />
                                  <span>Прикрепить файл</span>
                                  <input
                                    type="file"
                                    accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                                    multiple
                                    onChange={(e) => handleGuarantorFilesSelected(g.localId, e)}
                                    className="hidden"
                                  />
                                </label>
                              </div>
                            </div>

                            <label className="flex items-center gap-2 text-xs text-slate-800 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={g.signedGuaranteeReceived}
                                onChange={(e) =>
                                  updateGuarantorItem(g.localId, (item) => ({
                                    ...item,
                                    signedGuaranteeReceived: e.target.checked,
                                  }))
                                }
                                className="rounded border-slate-300"
                              />
                              <span>Подписанный документ поручительства получен</span>
                            </label>

                            {g.attachments.length > 0 && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                                {g.attachments.map((att) => (
                                  <div
                                    key={att.id}
                                    className="p-2 bg-white border border-slate-200 rounded-lg flex items-center justify-between gap-2 text-xs"
                                  >
                                    <div className="min-w-0">
                                      <div className="font-medium text-slate-900 truncate">
                                        {att.title}
                                      </div>
                                      <div className="text-[11px] text-slate-500 font-mono truncate">
                                        {att.originalFilename} · {formatFileSize(att.sizeBytes)}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateGuarantorItem(g.localId, (item) => ({
                                          ...item,
                                          attachments: item.attachments.filter(
                                            (a) => a.id !== att.id
                                          ),
                                        }))
                                      }
                                      className="p-1 text-slate-400 hover:text-red-600 rounded"
                                      title="Удалить документ поручителя"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Связать с целевой закупкой (опционально)
              </label>
              <select
                value={purchaseId}
                onChange={(e) => handleSelectPurchase(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">— Ввести параметры товара вручную —</option>
                {purchases
                  .filter((p) => !p.contractId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.itemName} · Себестоимость {formatMoney(p.totalCostKopecks)} ({p.supplierName})
                    </option>
                  ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Наименование товара (предмет договора) *
              </label>
              <input
                type="text"
                value={itemTitle}
                onChange={(e) => setItemTitle(e.target.value)}
                placeholder="Например: Смартфон Samsung Galaxy S25 Ultra 512GB Titanium"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Цена покупки в магазине (₽) *
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                value={purchaseRubles}
                onChange={(e) => {
                  setPurchaseRubles(e.target.value);
                  setPreviewConfirmed(false);
                }}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Доставка (₽)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={deliveryRubles}
                  onChange={(e) => {
                    setDeliveryRubles(e.target.value);
                    setPreviewConfirmed(false);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Прочие затраты (₽)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={otherRubles}
                  onChange={(e) => {
                    setOtherRubles(e.target.value);
                    setPreviewConfirmed(false);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Тарифный профиль рассрочки
              </label>
              <select
                value={planId}
                onChange={(e) => handleSelectPlan(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.termMonths} мес. · наценка {p.markupPercent}% · взнос {p.downPaymentPercent}% (v{p.version})
                  </option>
                ))}
                <option value="">Индивидуальные условия договора</option>
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Срок (мес.)</label>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={termMonths}
                  onChange={(e) => {
                    setTermMonths(e.target.value);
                    setPreviewConfirmed(false);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Наценка (%)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={markupPercent}
                  onChange={(e) => {
                    setMarkupPercent(e.target.value);
                    setPreviewConfirmed(false);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">1-й взнос (%)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="99"
                  value={downPaymentPercent}
                  onChange={(e) => {
                    setDownPaymentPercent(e.target.value);
                    setPreviewConfirmed(false);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Правило округления платежей
              </label>
              <select
                value={roundingRule}
                onChange={(e) => {
                  setRoundingRule(e.target.value as RoundingRule);
                  setPreviewConfirmed(false);
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="kopeck">Точно до копейки (корректировка в последнем платеже)</option>
                <option value="ruble">До целого рубля (остаток в последнем платеже)</option>
                <option value="ten_rubles">До 10 рублей (остаток в последнем платеже)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Дата оформления договора
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPreviewConfirmed(false);
                }}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {/* Contract Photo / Scan Attachment Section */}
          <div className="p-4 border border-slate-200 rounded-xl bg-white space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Paperclip className="w-4 h-4 text-slate-700" />
                <div>
                  <div className="text-xs font-semibold text-slate-900">
                    Прикрепить договор (фото с телефона, скан или PDF)
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Поддерживаются форматы JPEG, PNG, WebP и PDF (до 10 МБ). Можно прикрепить несколько страниц.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 cursor-pointer flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Прикрепить договор</span>
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                    multiple
                    onChange={handleFilesSelected}
                    className="hidden"
                  />
                </label>
                <label className="px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5" />
                  <span>Сфотографировать</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    onChange={handleFilesSelected}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {attachments.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="p-2.5 border border-slate-200 rounded-lg bg-slate-50 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {att.previewDataUrl ? (
                        <img
                          src={att.previewDataUrl}
                          alt={att.originalFilename}
                          className="w-11 h-11 rounded object-cover border border-slate-200 shrink-0"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded bg-slate-200 flex items-center justify-center shrink-0">
                          <FileText className="w-5 h-5 text-slate-600" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-900 truncate">
                          {att.originalFilename}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {formatFileSize(att.sizeBytes)} · {att.mimeType}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((item) => item.id !== att.id))
                      }
                      className="p-1.5 text-slate-400 hover:text-red-600 rounded"
                      title="Удалить файл из вложений"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Detailed Server Calculation Preview */}
          {previewResult && (
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <Calculator className="w-4 h-4 text-slate-700" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Предварительный расчёт и график платежей (расчёт выполнен сервером в копейках)
                  </h3>
                </div>
                <span className="text-xs text-slate-500 font-mono">
                  {translateRoundingRule(previewResult.roundingRule)}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div>
                  <div className="text-slate-500">Полная себестоимость</div>
                  <div className="text-sm font-semibold font-mono text-slate-900 mt-0.5">
                    {formatMoney(previewResult.totalCostKopecks)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Наценка ({previewResult.markupPercent}%)</div>
                  <div className="text-sm font-semibold font-mono text-emerald-700 mt-0.5">
                    +{formatMoney(previewResult.markupKopecks)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Цена продажи</div>
                  <div className="text-sm font-semibold font-mono text-slate-900 mt-0.5">
                    {formatMoney(previewResult.salePriceKopecks)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">
                    Первый взнос ({previewResult.downPaymentPercent}%)
                  </div>
                  <div className="text-sm font-semibold font-mono text-slate-900 mt-0.5">
                    {formatMoney(previewResult.downPaymentKopecks)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Остаток в рассрочку</div>
                  <div className="text-sm font-semibold font-mono text-slate-900 mt-0.5">
                    {formatMoney(previewResult.financedPrincipalKopecks)}
                  </div>
                </div>
              </div>

              <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg bg-white">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="py-2 px-3 font-medium">№ платежа</th>
                      <th className="py-2 px-3 font-medium">Дата оплаты</th>
                      <th className="py-2 px-3 font-medium text-right">Сумма по графику</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewResult.schedule.map((row: any) => (
                      <tr key={row.installmentNumber}>
                        <td className="py-1.5 px-3 font-mono text-slate-700">
                          Платёж №{row.installmentNumber}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-slate-700">
                          {formatDateRu(row.dueDate)}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-right font-medium text-slate-900">
                          {formatMoney(row.plannedKopecks)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
                <label className="flex items-center gap-2 text-xs text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={collectDownPaymentNow}
                    onChange={(e) => setCollectDownPaymentNow(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Принять первоначальный взнос в кассу/банк сразу</span>
                </label>

                {collectDownPaymentNow && (
                  <>
                    <select
                      value={downPaymentAccountId}
                      onChange={(e) => setDownPaymentAccountId(e.target.value)}
                      className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          Зачислить на: {a.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={downPaymentMethod}
                      onChange={(e) =>
                        setDownPaymentMethod(e.target.value as 'cash' | 'bank_transfer')
                      }
                      className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="cash">Способ: Наличные ₽</option>
                      <option value="bank_transfer">Способ: Банковский перевод</option>
                    </select>
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-slate-200">
                <label className="flex items-start gap-2.5 text-xs font-medium text-slate-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={previewConfirmed}
                    onChange={(e) => setPreviewConfirmed(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300"
                  />
                  <span>
                    Я проверил расчёт полной себестоимости, наценки, первоначального взноса и график
                    платежей. Подтверждаю активацию договора с фиксацией указанных условий.
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={!previewConfirmed || submitting}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>{submitting ? 'Оформление...' : 'Подтвердить и активировать договор'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface EarlyPayoffModalProps {
  contract: ContractDTO;
  accounts: FinancialAccountDTO[];
  isOwner: boolean;
  onClose: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onSuccess: () => Promise<void>;
}

export const EarlyPayoffModal: React.FC<EarlyPayoffModalProps> = ({
  contract,
  accounts,
  isOwner,
  onClose,
  apiFetch,
  onSuccess,
}) => {
  const [options, setOptions] = useState<any[]>([]);
  const [selectedMode, setSelectedMode] = useState<string>('full_balance');
  const [manualRubles, setManualRubles] = useState<string>(
    String(contract.remainingDebtKopecks / 100)
  );
  const [accountId, setAccountId] = useState(accounts[0]?.id || 'acc_bank_main');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank_transfer'>('bank_transfer');
  const [reason, setReason] = useState('Досрочное закрытие договора по заявлению клиента');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadComparison = async (manualKop?: number) => {
    try {
      const data = await apiFetch(`/api/v1/contracts/${contract.id}/early-payoff-preview`, {
        method: 'POST',
        body: JSON.stringify({
          manualPayoffKopecks: manualKop,
        }),
      });
      setOptions(data.options || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка расчёта вариантов');
    }
  };

  useEffect(() => {
    loadComparison(parseRublesInputToKopecks(manualRubles));
  }, [manualRubles]);

  const selectedOption = options.find((o) => o.mode === selectedMode) || options[0];

  const handleApply = async () => {
    if (!selectedOption) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/contracts/${contract.id}/early-payoff-apply`, {
        method: 'POST',
        body: JSON.stringify({
          payoffAmountKopecks: selectedOption.payoffAmountKopecks,
          accountId,
          paymentMethod,
          reason,
        }),
      });
      await onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка проведения досрочного погашения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl p-4 sm:p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 break-words">
              Калькулятор сравнения вариантов досрочного погашения · {contract.contractNumber}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 break-words">
              Клиент: {contract.clientName} · Остаток по графику: {formatMoney(contract.remainingDebtKopecks)}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {options.map((opt) => {
            const active = selectedMode === opt.mode;
            return (
              <div
                key={opt.mode}
                onClick={() => setSelectedMode(opt.mode)}
                className={`p-4 rounded-xl border transition-colors cursor-pointer ${
                  active
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{opt.title}</div>
                    <p className="text-xs text-slate-500 mt-0.5">{opt.description}</p>
                    {opt.requiresLegalConfirmation && (
                      <p className="text-[11px] text-amber-700 mt-1">
                        Предварительная формула: применение скидки требует согласования владельцем и соответствия тексту договора
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-500">К оплате для закрытия</div>
                    <div className="text-base font-bold font-mono text-slate-900">
                      {formatMoney(opt.payoffAmountKopecks)}
                    </div>
                    <div className="text-xs font-mono text-emerald-700">
                      Скидка: {formatMoney(opt.discountKopecks)} · Сохраняемая наценка: {formatMoney(opt.retainedMarkupKopecks)}
                    </div>
                  </div>
                </div>

                {opt.mode === 'manual_owner' && active && (
                  <div className="mt-3 pt-3 border-t border-slate-200 flex items-center gap-3">
                    <label className="text-xs font-medium text-slate-700">
                      Утверждённая сумма к оплате (₽):
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={manualRubles}
                      onChange={(e) => setManualRubles(e.target.value)}
                      className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white w-44"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {isOwner ? (
          <div className="mt-5 pt-4 border-t border-slate-200 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Счёт зачисления средств
                </label>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Основание / комментарий к закрытию
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg"
              >
                Закрыть без изменений
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleApply}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                {loading
                  ? 'Проведение...'
                  : `Подтвердить закрытие за ${selectedOption ? formatMoney(selectedOption.payoffAmountKopecks) : ''}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 p-3 bg-slate-100 rounded-lg text-xs text-slate-600">
            Просмотр калькулятора доступен всем сотрудникам. Окончательное утверждение скидки и
            досрочное закрытие договора выполняет владелец бизнеса.
          </div>
        )}
      </div>
    </div>
  );
};

interface RestructureModalProps {
  contract: ContractDTO;
  isOwner: boolean;
  onClose: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onSuccess: () => Promise<void>;
}

export const RestructureScheduleModal: React.FC<RestructureModalProps> = ({
  contract,
  isOwner,
  onClose,
  apiFetch,
  onSuccess,
}) => {
  const [reason, setReason] = useState('Обновление графика с учётом внесённых платежей');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const activeScheduleItems = contract.schedule || [];
  const unpaidItems = activeScheduleItems.filter((i) => i.remainingKopecks > 0);
  const remainingMonthsCount = unpaidItems.length;
  const completedMonthsCount = Math.max(0, contract.termMonths - remainingMonthsCount);
  const monthlyPaymentRemaining =
    remainingMonthsCount > 0
      ? Math.floor(contract.remainingDebtKopecks / remainingMonthsCount)
      : 0;

  const activeVersionMeta = contract.scheduleHistory.find(
    (v) => v.version === contract.currentScheduleVersion
  );

  const handleRestructure = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/contracts/${contract.id}/restructure`, {
        method: 'POST',
        body: JSON.stringify({
          reason: reason.trim() || 'Обновление графика с учётом внесённых платежей',
        }),
      });
      await onSuccess();
      setNotice(
        `Утверждён новый график v${contract.currentScheduleVersion + 1}: старый график заменён, осталось платить ${remainingMonthsCount} мес. на сумму ${formatMoney(contract.remainingDebtKopecks)}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления графика');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl p-4 sm:p-6 max-h-[92vh] overflow-y-auto space-y-5">
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="flex items-start gap-2.5 min-w-0">
            <History className="w-5 h-5 text-slate-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 break-words">
                График платежей по договору · {contract.contractNumber}
              </h2>
              <p className="text-xs text-slate-500 break-words">
                Клиент: {contract.clientName} · Товар: {contract.itemTitle} · Текущая версия: v{contract.currentScheduleVersion}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Summary KPI cards: how many months left & how much left */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs">
          <div>
            <div className="text-slate-500">Осталось месяцев платить</div>
            <div className="text-base font-bold font-mono text-slate-900 mt-0.5">
              {remainingMonthsCount} мес.{' '}
              <span className="text-xs font-normal text-slate-500">из {contract.termMonths}</span>
            </div>
          </div>
          <div>
            <div className="text-slate-500">Закрыто месяцев</div>
            <div className="text-base font-bold font-mono text-emerald-700 mt-0.5">
              {completedMonthsCount} мес.
            </div>
          </div>
          <div>
            <div className="text-slate-500">Всего уже выплачено</div>
            <div className="text-base font-bold font-mono text-emerald-700 mt-0.5">
              {formatMoney(contract.totalPaidOnScheduleKopecks)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Осталось выплатить</div>
            <div className="text-base font-bold font-mono text-slate-900 mt-0.5">
              {formatMoney(contract.remainingDebtKopecks)}
            </div>
          </div>
        </div>

        {notice && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 font-medium">
            {notice}
          </div>
        )}

        {/* Active Schedule Only */}
        <div className="border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100 text-xs">
            <div className="font-semibold text-slate-900">
              Действующий график (v{contract.currentScheduleVersion}) · Осталось платежей: {remainingMonthsCount} мес.
            </div>
            {activeVersionMeta && (
              <div className="text-slate-500">
                {activeVersionMeta.changeReason} · {formatDateRu(activeVersionMeta.createdAt)}
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-100">
                  <th className="py-2 pr-3">№</th>
                  <th className="py-2 pr-3">Срок оплаты</th>
                  <th className="py-2 pr-3 text-right">Сумма по графику</th>
                  <th className="py-2 pr-3 text-right">Внесено</th>
                  <th className="py-2 pr-3 text-right">Осталось</th>
                  <th className="py-2">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {activeScheduleItems.map((item) => (
                  <tr
                    key={item.id}
                    className={item.status === 'paid' ? 'bg-emerald-50/40 text-slate-500' : ''}
                  >
                    <td className="py-2 pr-3 font-semibold text-slate-900">
                      #{item.installmentNumber}
                    </td>
                    <td className="py-2 pr-3">{formatDateRu(item.dueDate)}</td>
                    <td className="py-2 pr-3 text-right">{formatMoney(item.plannedKopecks)}</td>
                    <td className="py-2 pr-3 text-right text-emerald-700">
                      {formatMoney(item.paidKopecks)}
                    </td>
                    <td className="py-2 pr-3 text-right font-semibold text-slate-900">
                      {formatMoney(item.remainingKopecks)}
                    </td>
                    <td className="py-2 font-sans">
                      <span
                        className={
                          item.status === 'paid'
                            ? 'text-emerald-700 font-medium'
                            : item.daysOverdue > 0
                              ? 'text-red-600 font-medium'
                              : 'text-slate-700'
                        }
                      >
                        {translateScheduleStatus(item.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Approve new schedule version removing already paid months */}
        {isOwner && contract.remainingDebtKopecks > 0 && (
          <form onSubmit={handleRestructure} className="pt-4 border-t border-slate-200 space-y-4">
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1 text-xs">
              <div className="font-semibold text-slate-900">
                Обновить график с учётом оплаченных месяцев (будет создана версия v{contract.currentScheduleVersion + 1})
              </div>
              <div className="text-slate-600">
                Старый график заменится на новый: оплаченные месяцы будут убраны, а оставшийся долг{' '}
                <strong className="font-mono text-slate-900">
                  {formatMoney(contract.remainingDebtKopecks)}
                </strong>{' '}
                автоматически распределится на оставшиеся{' '}
                <strong className="font-mono text-slate-900">{remainingMonthsCount} мес.</strong> (по{' '}
                <strong className="font-mono text-slate-900">
                  {formatMoney(monthlyPaymentRemaining)}
                </strong>{' '}
                в месяц).
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Примечание / основание обновления графика
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Закрыть
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                {loading
                  ? 'Обновление графика...'
                  : `Утвердить новый график (${remainingMonthsCount} мес. · ${formatMoney(contract.remainingDebtKopecks)})`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

interface PrintableDocumentModalProps {
  contract: ContractDTO;
  templateType: 'contract' | 'schedule' | 'handover' | 'payoff';
  onClose: () => void;
}

export const PrintableDocumentModal: React.FC<PrintableDocumentModalProps> = ({
  contract,
  templateType,
  onClose,
}) => {
  const [sellerTitle, setSellerTitle] = useState(
    '[ФИО / ИП / Наименование Продавца — заполняется после согласования юр. статуса]'
  );

  const guarantors = contract.guarantors || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl p-4 sm:p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200 no-print">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 break-words">
              Предварительный шаблон документа · {contract.contractNumber}
            </h2>
            <p className="text-xs text-amber-700 mt-0.5 break-words">
              Внимание: система не является юридической консультацией. Проверьте текст шаблона с российским юристом (ст. 488, 489 ГК РФ).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg flex items-center gap-1.5"
            >
              <Printer className="w-3.5 h-3.5 shrink-0" />
              <span>Печать / Сохранить PDF</span>
            </button>
            <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="my-3 no-print">
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Реквизиты Продавца в печатной форме:
          </label>
          <input
            type="text"
            value={sellerTitle}
            onChange={(e) => setSellerTitle(e.target.value)}
            className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
          />
        </div>

        <div className="p-4 sm:p-6 border border-slate-300 rounded-lg text-xs text-slate-900 space-y-4 leading-relaxed">
          <div className="text-center border-b border-slate-200 pb-3">
            <div className="text-sm font-bold break-words">
              {templateType === 'contract' &&
                `ДОГОВОР КУПЛИ-ПРОДАЖИ ТОВАРА В РАССРОЧКУ № ${contract.contractNumber}`}
              {templateType === 'schedule' &&
                `ПРИЛОЖЕНИЕ №1: ГРАФИК ПЛАТЕЖЕЙ К ДОГОВОРУ № ${contract.contractNumber} (Версия v${contract.currentScheduleVersion})`}
              {templateType === 'handover' &&
                `АКТ ПРИЁМА-ПЕРЕДАЧИ ТОВАРА ПО ДОГОВОРУ № ${contract.contractNumber}`}
              {templateType === 'payoff' &&
                `СПРАВКА О ПОЛНОМ ИСПОЛНЕНИИ ОБЯЗАТЕЛЬСТВ ПО ДОГОВОРУ № ${contract.contractNumber}`}
            </div>
            <div className="text-slate-500 mt-1">Дата составления: {formatDateRu(contract.startDate)}</div>
          </div>

          <div className="space-y-2 break-words">
            <p>
              <strong>Продавец:</strong> {sellerTitle}
            </p>
            <p>
              <strong>Покупатель (Основной плательщик):</strong> {contract.clientName}, контактный телефон: {contract.clientPhone}
            </p>
            <p>
              <strong>Наименование передаваемого товара:</strong> {contract.itemTitle}
            </p>
          </div>

          {guarantors.length > 0 && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="font-semibold text-slate-900">
                Поручители по договору ({guarantors.length}):
              </div>
              <div className="space-y-1.5">
                {guarantors.map((g, idx) => (
                  <div key={g.id} className="text-xs border-b border-slate-200 last:border-b-0 pb-1.5 last:pb-0 break-words">
                    <strong>Поручитель №{idx + 1}:</strong> {g.fullName} · Тел.: {g.phone}
                    {g.secondaryPhone ? `, доп. тел.: ${g.secondaryPhone}` : ''}
                    {g.documentRef ? ` · Паспорт: ${g.documentRef}` : ''}
                    {g.address ? ` · Адрес: ${g.address}` : ''}
                    {g.notes ? ` · Примечание: ${g.notes}` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono">
            <div>
              <div className="text-[11px] font-sans text-slate-500">Цена продажи в рассрочку</div>
              <div className="font-semibold break-words">{formatMoney(contract.salePriceKopecks)}</div>
            </div>
            <div>
              <div className="text-[11px] font-sans text-slate-500">Первоначальный взнос</div>
              <div className="font-semibold break-words">{formatMoney(contract.downPaymentKopecks)}</div>
            </div>
            <div>
              <div className="text-[11px] font-sans text-slate-500">Остаток к погашению</div>
              <div className="font-semibold break-words">{formatMoney(contract.financedPrincipalKopecks)}</div>
            </div>
            <div>
              <div className="text-[11px] font-sans text-slate-500">Текущий остаток долга</div>
              <div className="font-semibold break-words">{formatMoney(contract.remainingDebtKopecks)}</div>
            </div>
          </div>

          {(templateType === 'contract' || templateType === 'schedule') && (
            <div>
              <div className="font-semibold mb-2">
                Утверждённый график ежемесячных платежей ({contract.termMonths} мес.):
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] border-collapse border border-slate-300 text-xs font-mono">
                  <thead>
                    <tr className="bg-slate-50 font-sans">
                      <th className="border border-slate-300 p-1.5 text-left">№</th>
                      <th className="border border-slate-300 p-1.5 text-left">Дата платежа</th>
                      <th className="border border-slate-300 p-1.5 text-right">Сумма по графику</th>
                      <th className="border border-slate-300 p-1.5 text-right">Фактически внесено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contract.schedule.map((item) => (
                      <tr key={item.id}>
                        <td className="border border-slate-300 p-1.5">{item.installmentNumber}</td>
                        <td className="border border-slate-300 p-1.5">{formatDateRu(item.dueDate)}</td>
                        <td className="border border-slate-300 p-1.5 text-right">
                          {formatMoney(item.plannedKopecks)}
                        </td>
                        <td className="border border-slate-300 p-1.5 text-right">
                          {formatMoney(item.paidKopecks)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="pt-8 space-y-6 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8">
              <div className="border-t border-slate-400 pt-2 break-words">
                Подпись Продавца: ______________________
              </div>
              <div className="border-t border-slate-400 pt-2 break-words">
                Подпись Покупателя ({contract.clientName}): ______________________
              </div>
            </div>

            {guarantors.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
                {guarantors.map((g, idx) => (
                  <div key={g.id} className="border-t border-slate-400 pt-2">
                    Подпись Поручителя №{idx + 1} ({g.fullName}): ______________________
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

