import React, { useState, useMemo, useEffect } from 'react';
import {
  ClientDTO,
  ContractDTO,
  DocumentDTO,
  StatusRulesConfigDTO,
} from '../shared/types';
import {
  formatDateRu,
  formatDateTimeRu,
  formatFileSize,
  formatMoney,
  getClientPaymentStatusMeta,
  parseRublesInputToKopecks,
} from '../utils/format';
import { buildDirectWhatsAppUrl, formatTelHref, normalizePhoneE164 } from '../shared/clientStatus';
import {
  Phone,
  Copy,
  Check,
  MessageCircle,
  FileText,
  Paperclip,
  Download,
  Eye,
  RefreshCw,
  Search,
  AlertTriangle,
  X,
  ShieldCheck,
  Camera,
  Info,
  ExternalLink,
  Trash2,
} from 'lucide-react';

interface DocumentPreviewModalProps {
  doc: DocumentDTO;
  onClose: () => void;
  fetchProtectedBlob: (path: string) => Promise<Blob>;
  downloadProtectedFile: (path: string, fallbackFilename: string) => Promise<void>;
  onDeleteDocument?: (doc: DocumentDTO) => Promise<void>;
}

export const DocumentPreviewModal: React.FC<DocumentPreviewModalProps> = ({
  doc,
  onClose,
  fetchProtectedBlob,
  downloadProtectedFile,
  onDeleteDocument,
}) => {
  const isImage = doc.mimeType.startsWith('image/');
  const isPdf = doc.mimeType === 'application/pdf';
  const previewUrl = `/api/v1/documents/${doc.id}/preview`;
  const downloadUrl = `/api/v1/documents/${doc.id}/download`;

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(isImage || isPdf);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  useEffect(() => {
    if (!isImage && !isPdf) {
      setLoading(false);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    setLoading(true);
    setLoadError(null);

    fetchProtectedBlob(previewUrl)
      .then((blob) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить предпросмотр файла');
        setLoading(false);
      });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [doc.id, isImage, isPdf, previewUrl, fetchProtectedBlob]);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      await downloadProtectedFile(downloadUrl, doc.originalFilename || `${doc.id}.bin`);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Ошибка скачивания файла');
    } finally {
      setDownloading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!onDeleteDocument) return;
    try {
      setDeleting(true);
      await onDeleteDocument(doc);
      onClose();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Ошибка удаления файла');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 truncate">{doc.title}</h3>
            <p className="text-xs text-slate-500 font-mono truncate">
              {doc.originalFilename} · {formatFileSize(doc.sizeBytes)} · Загружен{' '}
              {formatDateTimeRu(doc.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onDeleteDocument && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Удалить фото / файл</span>
              </button>
            )}
            {onDeleteDocument && confirmDelete && (
              <div className="flex items-center gap-1.5 bg-red-50 border border-red-300 px-2.5 py-1 rounded-lg">
                <span className="text-xs font-medium text-red-800">Удалить?</span>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleConfirmDelete}
                  className="px-2 py-0.5 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-60"
                >
                  {deleting ? 'Удаление...' : 'Да, удалить'}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-0.5 text-xs text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100"
                >
                  Отмена
                </button>
              </div>
            )}
            <button
              type="button"
              disabled={downloading}
              onClick={handleDownload}
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{downloading ? 'Скачивание...' : 'Скачать оригинал'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 flex-1 overflow-auto bg-slate-100 flex items-center justify-center min-h-[360px]">
          {loading && (
            <div className="text-center p-6 text-xs text-slate-600">
              Загрузка защищённого документа из хранилища...
            </div>
          )}
          {!loading && loadError && (
            <div className="text-center p-6 bg-white rounded-xl border border-red-200 space-y-2 max-w-md">
              <AlertTriangle className="w-8 h-8 text-red-600 mx-auto" />
              <div className="text-xs font-medium text-red-800">{loadError}</div>
            </div>
          )}
          {!loading && !loadError && isImage && blobUrl && (
            <img
              src={blobUrl}
              alt={doc.title}
              className="max-w-full max-h-[75vh] object-contain rounded border border-slate-300 bg-white"
            />
          )}
          {!loading && !loadError && isPdf && blobUrl && (
            <iframe
              src={blobUrl}
              title={doc.title}
              className="w-full h-[75vh] rounded border border-slate-300 bg-white"
            />
          )}
          {!loading && !loadError && !isImage && !isPdf && (
            <div className="text-center p-8 bg-white rounded-xl border border-slate-200 space-y-3">
              <FileText className="w-10 h-10 text-slate-500 mx-auto" />
              <div className="text-sm font-medium text-slate-900">{doc.originalFilename}</div>
              <button
                type="button"
                disabled={downloading}
                onClick={handleDownload}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{downloading ? 'Скачивание...' : 'Скачать файл'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface QuickCallAndCopyBarProps {
  phone: string;
  clientName: string;
  onNotice?: (msg: string) => void;
  onError?: (err: string) => void;
}

export const QuickCallAndCopyBar: React.FC<QuickCallAndCopyBarProps> = ({
  phone,
  clientName,
  onNotice,
  onError,
}) => {
  const [copied, setCopied] = useState(false);
  const telHref = formatTelHref(phone);
  const normalized = normalizePhoneE164(phone);
  const waHref = buildDirectWhatsAppUrl(phone);

  const handleCallClick = (e: React.MouseEvent) => {
    if (!telHref || !normalized) {
      e.preventDefault();
      onError?.(
        `Некорректный или пустой номер телефона у клиента «${clientName}» (${phone || 'не указан'}). Проверьте номер.`
      );
      return;
    }
    onNotice?.(
      `Вызов передан в телефонное приложение для номера ${normalized}. Статус звонка зависит от вашего устройства.`
    );
  };

  const handleWhatsAppClick = (e: React.MouseEvent) => {
    if (!waHref || !normalized) {
      e.preventDefault();
      onError?.(
        `Некорректный или пустой номер телефона для WhatsApp у клиента «${clientName}» (${phone || 'не указан'}). Проверьте номер.`
      );
      return;
    }
    onNotice?.(
      `Открыт чат WhatsApp с клиентом «${clientName}» (${normalized}).`
    );
  };

  const handleCopy = async () => {
    const textToCopy = normalized || phone.trim();
    if (!textToCopy) {
      onError?.('Номер телефона отсутствует.');
      return;
    }
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onNotice?.(`Номер ${textToCopy} скопирован в буфер обмена.`);
    } catch {
      onError?.(`Не удалось скопировать автоматически: ${textToCopy}`);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      <a
        href={waHref || '#'}
        target={waHref ? '_blank' : undefined}
        rel={waHref ? 'noopener noreferrer' : undefined}
        onClick={handleWhatsAppClick}
        className={`px-2.5 py-1 text-xs font-medium rounded-lg border inline-flex items-center gap-1.5 transition-colors ${
          waHref
            ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 shadow-xs'
            : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
        }`}
        title={waHref ? `Написать в WhatsApp (${normalized})` : 'Номер телефона некорректен'}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        <span>Написать в WhatsApp</span>
      </a>
      <a
        href={telHref || '#'}
        onClick={handleCallClick}
        className={`px-2.5 py-1 text-xs font-medium rounded-lg border inline-flex items-center gap-1.5 transition-colors ${
          telHref
            ? 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100'
            : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
        }`}
        title={telHref ? `Позвонить ${normalized}` : 'Номер телефона некорректен'}
      >
        <Phone className="w-3.5 h-3.5 text-emerald-700" />
        <span>Позвонить</span>
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className="px-2 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1"
        title="Скопировать номер телефона"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-emerald-700">Скопировано</span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            <span>Копировать</span>
          </>
        )}
      </button>
    </div>
  );
};

interface ClientDetailsModalProps {
  client: ClientDTO;
  contracts: ContractDTO[];
  documents: DocumentDTO[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onOpenWhatsAppForContract: (contractId: string) => void;
  onEditClient: (client: ClientDTO) => void;
  fetchProtectedBlob: (path: string) => Promise<Blob>;
  downloadProtectedFile: (path: string, fallbackFilename: string) => Promise<void>;
}

export const ClientDetailsModal: React.FC<ClientDetailsModalProps> = ({
  client,
  contracts,
  documents,
  onClose,
  onRefresh,
  apiFetch,
  onOpenWhatsAppForContract,
  onEditClient,
  fetchProtectedBlob,
  downloadProtectedFile,
}) => {
  const [previewDoc, setPreviewDoc] = useState<DocumentDTO | null>(null);
  const [uploadingForContractId, setUploadingForContractId] = useState<string | null>(null);
  const [replacingDocId, setReplacingDocId] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchivedDocs, setShowArchivedDocs] = useState(false);

  const clientContracts = useMemo(
    () => contracts.filter((c) => c.clientId === client.id),
    [contracts, client.id]
  );

  const clientDocuments = useMemo(
    () =>
      documents.filter(
        (d) =>
          (d.clientId === client.id ||
            (d.entityType === 'client' && d.entityId === client.id) ||
            clientContracts.some(
              (c) => d.contractId === c.id || (d.entityType === 'contract' && d.entityId === c.id)
            )) &&
          (showArchivedDocs || !d.isArchived)
      ),
    [documents, client.id, clientContracts, showArchivedDocs]
  );

  const statusMeta = getClientPaymentStatusMeta(client.paymentStatus);

  const handleUploadFileForTarget = async (
    e: React.ChangeEvent<HTMLInputElement>,
    targetEntityType: 'client' | 'contract',
    targetEntityId: string,
    defaultTitlePrefix: string
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setUploadingForContractId(targetEntityId);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

      await apiFetch('/api/v1/documents/upload', {
        method: 'POST',
        body: JSON.stringify({
          entityType: targetEntityType,
          entityId: targetEntityId,
          clientId: client.id,
          contractId: targetEntityType === 'contract' ? targetEntityId : undefined,
          docCategory: targetEntityType === 'contract' ? 'contract_scan' : 'passport_id',
          title: `${defaultTitlePrefix} (${file.name})`,
          originalFilename: file.name,
          mimeType: file.type,
          contentBase64: base64,
        }),
      });

      await onRefresh();
      setNotice(`Файл «${file.name}» успешно прикреплён и сохранён.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки файла');
    } finally {
      setUploadingForContractId(null);
      e.target.value = '';
    }
  };

  const handleReplaceDocument = async (
    e: React.ChangeEvent<HTMLInputElement>,
    oldDoc: DocumentDTO
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setReplacingDocId(oldDoc.id);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

      await apiFetch(`/api/v1/documents/${oldDoc.id}/replace`, {
        method: 'POST',
        body: JSON.stringify({
          title: oldDoc.title,
          originalFilename: file.name,
          mimeType: file.type,
          contentBase64: base64,
          docCategory: oldDoc.docCategory,
        }),
      });

      await onRefresh();
      setNotice(
        `Документ «${oldDoc.title}» обновлён новым файлом «${file.name}» (предыдущая версия сохранена в архиве).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка замены документа');
    } finally {
      setReplacingDocId(null);
      e.target.value = '';
    }
  };

  const handleDeleteDocument = async (doc: DocumentDTO) => {
    setError(null);
    setNotice(null);
    setDeletingDocId(doc.id);
    try {
      await apiFetch(`/api/v1/documents/${doc.id}`, {
        method: 'DELETE',
      });
      setConfirmDeleteDocId(null);
      await onRefresh();
      setNotice(`Файл «${doc.originalFilename}» удалён.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка удаления файла';
      setError(msg);
      throw err;
    } finally {
      setDeletingDocId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-lg font-semibold text-slate-900">{client.fullName}</h2>
              <span
                className={`px-2.5 py-0.5 text-xs font-medium border rounded-md inline-flex items-center gap-1.5 ${statusMeta.badgeClass}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                <span>{statusMeta.label}</span>
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              Основной телефон: {client.phone}
              {client.secondaryPhone ? ` · Доп. телефон: ${client.secondaryPhone}` : ''}
              {client.documentRef ? ` · Паспорт: ${client.documentRef}` : ''}
              {client.address ? ` · Адрес: ${client.address}` : ''}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <QuickCallAndCopyBar
              phone={client.phone}
              clientName={client.fullName}
              onNotice={setNotice}
              onError={setError}
            />
            <button
              type="button"
              onClick={() => onEditClient(client)}
              className="px-3 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Изменить анкету
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {notice && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-emerald-700 font-medium">
              Закрыть
            </button>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-700 font-medium">
              Закрыть
            </button>
          </div>
        )}

        {/* Why this status was assigned */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
            <Info className="w-4 h-4 text-slate-700" />
            <span>Обоснование присвоенного статуса («{statusMeta.label}»)</span>
          </div>
          <p className="text-xs text-slate-700 leading-relaxed">
            {client.paymentStatusReason || statusMeta.description}
          </p>
        </div>

        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3.5 border border-slate-200 rounded-xl bg-white">
            <div className="text-[11px] text-slate-500">Активных договоров</div>
            <div className="text-base font-semibold font-mono text-slate-900 mt-1">
              {client.activeContractsCount ?? 0}
              {client.completedContractsCount ? (
                <span className="text-xs font-normal text-slate-500 ml-1.5">
                  (закрыто: {client.completedContractsCount})
                </span>
              ) : null}
            </div>
          </div>
          <div className="p-3.5 border border-slate-200 rounded-xl bg-white">
            <div className="text-[11px] text-slate-500">Сумма оставшегося долга</div>
            <div className="text-base font-semibold font-mono text-slate-900 mt-1">
              {formatMoney(client.totalRemainingDebtKopecks || 0)}
            </div>
          </div>
          <div className="p-3.5 border border-slate-200 rounded-xl bg-white">
            <div className="text-[11px] text-slate-500">Сумма текущей просрочки</div>
            <div
              className={`text-base font-semibold font-mono mt-1 ${
                (client.totalOverdueKopecks || 0) > 0 ? 'text-red-600' : 'text-emerald-700'
              }`}
            >
              {formatMoney(client.totalOverdueKopecks || 0)}
            </div>
          </div>
          <div className="p-3.5 border border-slate-200 rounded-xl bg-white">
            <div className="text-[11px] text-slate-500">Дата ближайшего платежа</div>
            <div className="text-base font-semibold font-mono text-slate-900 mt-1">
              {client.nextPaymentDate ? formatDateRu(client.nextPaymentDate) : 'Нет предстоящих'}
            </div>
          </div>
        </div>

        {/* Contracts of this client */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Договоры клиента ({clientContracts.length})
          </h3>
          {clientContracts.length === 0 ? (
            <div className="p-4 border border-slate-200 rounded-xl text-xs text-slate-500 bg-slate-50">
              У данного клиента пока нет оформленных договоров рассрочки.
            </div>
          ) : (
            <div className="space-y-2.5">
              {clientContracts.map((cnt) => {
                const cMeta = getClientPaymentStatusMeta(cnt.contractStatus);
                const contractDocs = documents.filter(
                  (d) =>
                    (d.contractId === cnt.id ||
                      (d.entityType === 'contract' && d.entityId === cnt.id)) &&
                    !d.isArchived
                );
                return (
                  <div
                    key={cnt.id}
                    className="p-3.5 border border-slate-200 rounded-xl bg-white space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-semibold text-slate-900">
                            {cnt.contractNumber}
                          </span>
                          <span className="text-xs font-medium text-slate-800">
                            · {cnt.itemTitle}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-medium border rounded-md ${cMeta.badgeClass}`}
                          >
                            {cMeta.label}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          От {formatDateRu(cnt.startDate)} · Цена продажи:{' '}
                          <span className="font-mono">{formatMoney(cnt.salePriceKopecks)}</span> ·
                          Остаток долга:{' '}
                          <span className="font-mono font-medium text-slate-900">
                            {formatMoney(cnt.remainingDebtKopecks)}
                          </span>
                          {cnt.overdueKopecks > 0 && (
                            <span className="text-red-600 font-mono ml-2">
                              (Просрочка: {formatMoney(cnt.overdueKopecks)})
                            </span>
                          )}
                        </div>
                        {cnt.contractStatusReason && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Статус договора: {cnt.contractStatusReason}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer inline-flex items-center gap-1.5">
                          <Paperclip className="w-3.5 h-3.5" />
                          <span>
                            {uploadingForContractId === cnt.id
                              ? 'Загрузка...'
                              : 'Прикрепить договор'}
                          </span>
                          <input
                            type="file"
                            accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                            onChange={(e) =>
                              handleUploadFileForTarget(
                                e,
                                'contract',
                                cnt.id,
                                `Договор ${cnt.contractNumber}`
                              )
                            }
                            className="hidden"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenWhatsAppForContract(cnt.id);
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 inline-flex items-center gap-1.5"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          <span>Отправить в WhatsApp</span>
                        </button>
                      </div>
                    </div>

                    {/* Guarantors of this contract */}
                    {cnt.guarantors && cnt.guarantors.length > 0 && (
                      <div className="pt-2 border-t border-slate-100 space-y-1.5">
                        <div className="text-[11px] font-semibold text-slate-700">
                          Поручители по договору ({cnt.guarantors.length}):
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {cnt.guarantors.map((g) => (
                            <div
                              key={g.id}
                              className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900">
                                  Поручитель №{g.guarantorOrder}: {g.fullName}
                                </span>
                                <span
                                  className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                                    g.signedGuaranteeReceived
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {g.signedGuaranteeReceived ? 'Подписано' : 'Без подписи'}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-600 font-mono">
                                Тел.: {g.phone}
                                {g.secondaryPhone ? ` · Доп.: ${g.secondaryPhone}` : ''}
                              </div>
                              {(g.documentRef || g.address) && (
                                <div className="text-[11px] text-slate-500">
                                  {g.documentRef ? `Паспорт: ${g.documentRef}` : ''}
                                  {g.documentRef && g.address ? ' · ' : ''}
                                  {g.address ? `Адрес: ${g.address}` : ''}
                                </div>
                              )}
                              {g.notes && (
                                <div className="text-[11px] text-slate-500 italic">
                                  Прим.: {g.notes}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Attached contract files */}
                    {contractDocs.length > 0 && (
                      <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2">
                        {contractDocs.map((doc) => (
                          <div
                            key={doc.id}
                            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs flex items-center gap-2"
                          >
                            <FileText className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                            <span className="truncate max-w-[180px]" title={doc.originalFilename}>
                              {doc.originalFilename}
                            </span>
                            <span className="text-[10px] text-slate-400 font-mono">
                              ({formatFileSize(doc.sizeBytes)})
                            </span>
                            <button
                              type="button"
                              onClick={() => setPreviewDoc(doc)}
                              className="text-slate-700 hover:text-slate-900 font-medium inline-flex items-center gap-0.5"
                              title="Предпросмотр файла"
                            >
                              <Eye className="w-3.5 h-3.5" />
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
                                  setError(
                                    err instanceof Error ? err.message : 'Ошибка скачивания файла'
                                  );
                                }
                              }}
                              className="text-slate-700 hover:text-slate-900"
                              title="Скачать оригинал"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <label
                              className="text-amber-700 hover:text-amber-900 cursor-pointer"
                              title="Заменить документ (предыдущий файл сохранится в архиве)"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <input
                                type="file"
                                accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                                onChange={(e) => handleReplaceDocument(e, doc)}
                                className="hidden"
                              />
                            </label>
                            {confirmDeleteDocId === doc.id ? (
                              <span className="inline-flex items-center gap-1 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                                <button
                                  type="button"
                                  disabled={deletingDocId === doc.id}
                                  onClick={() => handleDeleteDocument(doc).catch(() => {})}
                                  className="text-[11px] font-semibold text-red-700 hover:underline"
                                >
                                  {deletingDocId === doc.id ? '...' : 'Удалить'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteDocId(null)}
                                  className="text-[11px] text-slate-500 hover:text-slate-800"
                                >
                                  Отмена
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteDocId(doc.id)}
                                className="text-red-600 hover:text-red-800"
                                title="Удалить прикреплённое фото / файл"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Participation as Guarantor on other contracts */}
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Поручительство по договорам других клиентов ({client.guarantorContracts?.length || 0})
              </h3>
              <p className="text-[11px] text-slate-500">
                Договоры, в которых {client.fullName} выступает поручителем. Суммы этих обязательств учитываются справочно и не увеличивают личный долг плательщика.
              </p>
            </div>
          </div>

          {!client.guarantorContracts || client.guarantorContracts.length === 0 ? (
            <div className="p-3.5 border border-slate-200 rounded-xl text-xs text-slate-500 bg-slate-50">
              Клиент не выступает поручителем ни по одному договору.
            </div>
          ) : (
            <div className="space-y-2">
              {client.guarantorContracts.map((gc) => (
                <div
                  key={gc.guarantorRecordId}
                  className="p-3.5 border border-indigo-200 bg-indigo-50/40 rounded-xl flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="px-2 py-0.5 bg-indigo-100 text-indigo-900 font-semibold rounded text-[11px]">
                        Поручитель №{gc.guarantorOrder}
                      </span>
                      <span className="font-mono font-bold text-slate-900">
                        Договор {gc.contractNumber}
                      </span>
                      <span className="text-slate-700 font-medium">· {gc.itemTitle}</span>
                      <span
                        className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                          gc.signedGuaranteeReceived
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {gc.signedGuaranteeReceived
                          ? 'Поручительство подписано'
                          : 'Ожидает подписи'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-700">
                      Основной плательщик:{' '}
                      <strong className="text-slate-900">{gc.borrowerName}</strong> · Тел.:{' '}
                      <span className="font-mono">{gc.borrowerPhone}</span> · Оформлен:{' '}
                      <span className="font-mono">{formatDateRu(gc.startDate)}</span>
                    </div>
                    {gc.notes && (
                      <div className="text-[11px] text-slate-600 italic">
                        Примечание к поручительству: {gc.notes}
                      </div>
                    )}
                  </div>

                  <div className="text-right space-y-0.5">
                    <div className="text-[11px] text-slate-500">
                      Остаток долга заёмщика:{' '}
                      <span className="font-mono font-semibold text-slate-900">
                        {formatMoney(gc.remainingDebtKopecks)}
                      </span>
                    </div>
                    {gc.overdueKopecks > 0 ? (
                      <div className="text-[11px] text-red-600 font-mono font-semibold">
                        Просрочка по договору: {formatMoney(gc.overdueKopecks)}
                      </div>
                    ) : (
                      <div className="text-[11px] text-emerald-700">Просрочек нет</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* All Client & Contract Documents Section */}
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Прикреплённые фотографии и сканы документов ({clientDocuments.length})
              </h3>
              <p className="text-[11px] text-slate-500">
                При замене файла старый документ не удаляется, а переводится в архив версий.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchivedDocs}
                  onChange={(e) => setShowArchivedDocs(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Показать архивные версии</span>
              </label>
              <label className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 cursor-pointer inline-flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5" />
                <span>Загрузить документ клиента</span>
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) =>
                    handleUploadFileForTarget(e, 'client', client.id, `Документ клиента ${client.fullName}`)
                  }
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {clientDocuments.length === 0 ? (
            <div className="p-4 border border-slate-200 rounded-xl text-xs text-slate-500 bg-slate-50">
              К карточке клиента и его договорам пока не прикреплено ни одного файла.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {clientDocuments.map((doc) => (
                <div
                  key={doc.id}
                  className={`p-3 border rounded-xl flex items-center justify-between gap-3 ${
                    doc.isArchived
                      ? 'bg-slate-100 border-slate-300 opacity-75'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-900 truncate flex items-center gap-1.5">
                      <span className="truncate">{doc.title}</span>
                      {doc.isArchived && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-slate-200 text-slate-700 rounded">
                          Архив
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">
                      {doc.originalFilename} · {formatFileSize(doc.sizeBytes)} ·{' '}
                      {formatDateTimeRu(doc.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(doc)}
                      className="px-2 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1"
                    >
                      <Eye className="w-3.5 h-3.5" />
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
                          setError(err instanceof Error ? err.message : 'Ошибка скачивания файла');
                        }
                      }}
                      className="px-2 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1"
                      title="Скачать оригинал"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    {!doc.isArchived && (
                      <label className="px-2 py-1 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded hover:bg-amber-100 cursor-pointer inline-flex items-center gap-1">
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>{replacingDocId === doc.id ? '...' : 'Заменить'}</span>
                        <input
                          type="file"
                          accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                          onChange={(e) => handleReplaceDocument(e, doc)}
                          className="hidden"
                        />
                      </label>
                    )}
                    {confirmDeleteDocId === doc.id ? (
                      <div className="inline-flex items-center gap-1 bg-red-50 border border-red-200 px-2 py-1 rounded">
                        <button
                          type="button"
                          disabled={deletingDocId === doc.id}
                          onClick={() => handleDeleteDocument(doc).catch(() => {})}
                          className="text-xs font-semibold text-red-700 hover:underline"
                        >
                          {deletingDocId === doc.id ? '...' : 'Да, удалить'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDocId(null)}
                          className="text-xs text-slate-600 hover:text-slate-900 ml-1"
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteDocId(doc.id)}
                        className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 inline-flex items-center gap-1"
                        title="Удалить фото / документ"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Удалить</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {previewDoc && (
        <DocumentPreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          fetchProtectedBlob={fetchProtectedBlob}
          downloadProtectedFile={downloadProtectedFile}
          onDeleteDocument={handleDeleteDocument}
        />
      )}
    </div>
  );
};

interface FindAndSendContractSectionProps {
  clients: ClientDTO[];
  contracts: ContractDTO[];
  documents: DocumentDTO[];
  initialSelectedContractId?: string | null;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onRefresh: () => Promise<void>;
  onOpenClientCard: (client: ClientDTO) => void;
  fetchProtectedBlob: (path: string) => Promise<Blob>;
  downloadProtectedFile: (path: string, fallbackFilename: string) => Promise<void>;
}

export const FindAndSendContractSection: React.FC<FindAndSendContractSectionProps> = ({
  clients,
  contracts,
  documents,
  initialSelectedContractId,
  apiFetch,
  onRefresh,
  onOpenClientCard,
  fetchProtectedBlob,
  downloadProtectedFile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedContractByClient, setSelectedContractByClient] = useState<Record<string, string>>(
    () => {
      if (initialSelectedContractId) {
        const found = contracts.find((c) => c.id === initialSelectedContractId);
        if (found) {
          return { [found.clientId]: found.id };
        }
      }
      return {};
    }
  );
  const [customMessages, setCustomMessages] = useState<Record<string, string>>({});
  const [whatsappSessionState, setWhatsappSessionState] = useState<
    Record<
      string,
      {
        statusNotice: string;
        whatsappUrl: string;
        normalizedPhone: string;
        selectedDocument: {
          id: string;
          title: string;
          originalFilename: string;
          downloadUrl: string;
        } | null;
      }
    >
  >({});
  const [previewDoc, setPreviewDoc] = useState<DocumentDTO | null>(null);
  const [uploadingContractId, setUploadingContractId] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredClients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    if (!q) return clients;
    return clients.filter((cl) => {
      const nameMatch = cl.fullName.toLowerCase().includes(q);
      const phoneMatch =
        cl.phone.toLowerCase().includes(q) ||
        (qDigits.length >= 3 && cl.phone.replace(/\D/g, '').includes(qDigits));
      const clientContracts = contracts.filter((c) => c.clientId === cl.id);
      const contractMatch = clientContracts.some(
        (c) =>
          c.contractNumber.toLowerCase().includes(q) || c.itemTitle.toLowerCase().includes(q)
      );
      return nameMatch || phoneMatch || contractMatch;
    });
  }, [clients, contracts, searchQuery]);

  const handleAttachFileToContract = async (
    e: React.ChangeEvent<HTMLInputElement>,
    contract: ContractDTO
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    setUploadingContractId(contract.id);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      await apiFetch('/api/v1/documents/upload', {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'contract',
          entityId: contract.id,
          clientId: contract.clientId,
          contractId: contract.id,
          docCategory: 'contract_scan',
          title: `Договор ${contract.contractNumber} (${file.name})`,
          originalFilename: file.name,
          mimeType: file.type,
          contentBase64: base64,
        }),
      });
      await onRefresh();
      setNotice(
        `Файл «${file.name}» прикреплён к договору ${contract.contractNumber}. Теперь его можно отправить клиенту.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка прикрепления файла договора');
    } finally {
      setUploadingContractId(null);
      e.target.value = '';
    }
  };

  const handleDeleteDocument = async (doc: DocumentDTO) => {
    setError(null);
    setNotice(null);
    setDeletingDocId(doc.id);
    try {
      await apiFetch(`/api/v1/documents/${doc.id}`, {
        method: 'DELETE',
      });
      setConfirmDeleteDocId(null);
      await onRefresh();
      setNotice(`Прикреплённый файл «${doc.originalFilename}» удалён.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка удаления файла';
      setError(msg);
      throw err;
    } finally {
      setDeletingDocId(null);
    }
  };

  const handlePrepareAndOpenWhatsApp = async (contract: ContractDTO) => {
    setError(null);
    setNotice(null);
    try {
      const data = await apiFetch(`/api/v1/contracts/${contract.id}/prepare-whatsapp`, {
        method: 'POST',
        body: JSON.stringify({
          customMessage: customMessages[contract.id] || undefined,
        }),
      });

      setWhatsappSessionState((prev) => ({
        ...prev,
        [contract.id]: {
          statusNotice: data.statusNotice || 'Чат открыт. Прикрепите договор и отправьте сообщение',
          whatsappUrl: data.whatsappUrl,
          normalizedPhone: data.normalizedPhone,
          selectedDocument: data.selectedDocument || null,
        },
      }));

      // Open WhatsApp Click to Chat in a new tab/window via anchor click (safe for iframe/browsers)
      const link = document.createElement('a');
      link.href = data.whatsappUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось подготовить отправку в WhatsApp.'
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Найти и отправить договор клиенту (WhatsApp и быстрый звонок)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Найдите клиента по фамилии, имени, отчеству или номеру телефона, проверьте прикреплённый скан/фото договора и откройте чат WhatsApp с готовым текстом
            </p>
          </div>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Введите фамилию, имя, отчество, телефон (+7...) или номер договора..."
            className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-xl bg-white"
          />
        </div>

        {notice && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-emerald-700 font-medium">
              Закрыть
            </button>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center gap-2 justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-red-700 font-medium">
              Закрыть
            </button>
          </div>
        )}
      </div>

      {filteredClients.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
          По запросу «{searchQuery}» клиенты или договоры не найдены.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredClients.map((client) => {
            const clientContracts = contracts.filter((c) => c.clientId === client.id);
            const selectedContractId =
              selectedContractByClient[client.id] || clientContracts[0]?.id || '';
            const activeContract =
              clientContracts.find((c) => c.id === selectedContractId) || clientContracts[0] || null;
            const statusMeta = getClientPaymentStatusMeta(client.paymentStatus);

            const contractDocs = activeContract
              ? documents.filter(
                  (d) =>
                    (d.contractId === activeContract.id ||
                      (d.entityType === 'contract' && d.entityId === activeContract.id)) &&
                    !d.isArchived
                )
              : [];

            const waSession = activeContract ? whatsappSessionState[activeContract.id] : undefined;

            return (
              <div
                key={client.id}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                {/* Client top row */}
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenClientCard(client)}
                        className="text-sm font-semibold text-slate-900 hover:underline text-left"
                      >
                        {client.fullName}
                      </button>
                      <span
                        className={`px-2.5 py-0.5 text-xs font-medium border rounded-md inline-flex items-center gap-1.5 ${statusMeta.badgeClass}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                        <span>{statusMeta.label}</span>
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 font-mono mt-1">
                      Телефон: {client.phone || 'не указан'} · Активных договоров:{' '}
                      {client.activeContractsCount ?? 0} · Остаток долга:{' '}
                      {formatMoney(client.totalRemainingDebtKopecks || 0)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <QuickCallAndCopyBar
                      phone={client.phone}
                      clientName={client.fullName}
                      onNotice={setNotice}
                      onError={setError}
                    />
                    <button
                      type="button"
                      onClick={() => onOpenClientCard(client)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      Карточка клиента
                    </button>
                  </div>
                </div>

                {/* Contract selector & WhatsApp workspace */}
                {clientContracts.length === 0 ? (
                  <div className="text-xs text-slate-500">
                    У клиента нет оформленных договоров рассрочки.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {clientContracts.length > 1 && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          У клиента несколько договоров ({clientContracts.length}) — выберите нужный договор:
                        </label>
                        <select
                          value={activeContract?.id || ''}
                          onChange={(e) =>
                            setSelectedContractByClient((prev) => ({
                              ...prev,
                              [client.id]: e.target.value,
                            }))
                          }
                          className="w-full sm:w-auto px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        >
                          {clientContracts.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.contractNumber} от {formatDateRu(c.startDate)} — {c.itemTitle} (остаток:{' '}
                              {formatMoney(c.remainingDebtKopecks)})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {activeContract && (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-semibold text-slate-900 flex items-center gap-2">
                              <span className="font-mono">{activeContract.contractNumber}</span>
                              <span>· {activeContract.itemTitle}</span>
                              <span
                                className={`px-2 py-0.5 text-[10px] font-medium border rounded-md ${
                                  getClientPaymentStatusMeta(activeContract.contractStatus).badgeClass
                                }`}
                              >
                                {getClientPaymentStatusMeta(activeContract.contractStatus).label}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-600 mt-0.5 font-mono">
                              Дата договора: {formatDateRu(activeContract.startDate)} · Цена продажи:{' '}
                              {formatMoney(activeContract.salePriceKopecks)} · Первый взнос:{' '}
                              {formatMoney(activeContract.downPaymentKopecks)} · Остаток к оплате:{' '}
                              {formatMoney(activeContract.remainingDebtKopecks)}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer inline-flex items-center gap-1.5">
                              <Paperclip className="w-3.5 h-3.5" />
                              <span>
                                {uploadingContractId === activeContract.id
                                  ? 'Загрузка...'
                                  : 'Прикрепить скан/фото договора'}
                              </span>
                              <input
                                type="file"
                                accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                                onChange={(e) => handleAttachFileToContract(e, activeContract)}
                                className="hidden"
                              />
                            </label>

                            <button
                              type="button"
                              onClick={() => handlePrepareAndOpenWhatsApp(activeContract)}
                              className="px-3.5 py-1.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 inline-flex items-center gap-1.5"
                            >
                              <MessageCircle className="w-4 h-4" />
                              <span>Отправить в WhatsApp</span>
                            </button>
                          </div>
                        </div>

                        {/* Attached files for this contract */}
                        <div className="space-y-1.5">
                          <div className="text-[11px] font-medium text-slate-700">
                            Прикреплённые файлы договора ({contractDocs.length}):
                          </div>
                          {contractDocs.length === 0 ? (
                            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              К этому договору ещё не прикреплён скан или фотография. Вы можете прикрепить файл кнопкой выше или отправить текстовые реквизиты договора.
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {contractDocs.map((doc) => (
                                <div
                                  key={doc.id}
                                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs flex items-center gap-2"
                                >
                                  <FileText className="w-3.5 h-3.5 text-slate-700" />
                                  <span className="font-medium text-slate-900">
                                    {doc.originalFilename}
                                  </span>
                                  <span className="text-[11px] text-slate-500 font-mono">
                                    ({formatFileSize(doc.sizeBytes)} · {formatDateRu(doc.createdAt)})
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setPreviewDoc(doc)}
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
                                        setError(
                                          err instanceof Error
                                            ? err.message
                                            : 'Ошибка скачивания файла'
                                        );
                                      }
                                    }}
                                    className="px-2 py-0.5 text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1"
                                  >
                                    <Download className="w-3 h-3" />
                                    <span>Скачать файл для вложения</span>
                                  </button>
                                  {confirmDeleteDocId === doc.id ? (
                                    <span className="inline-flex items-center gap-1 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
                                      <button
                                        type="button"
                                        disabled={deletingDocId === doc.id}
                                        onClick={() => handleDeleteDocument(doc).catch(() => {})}
                                        className="text-[11px] font-semibold text-red-700 hover:underline"
                                      >
                                        {deletingDocId === doc.id ? '...' : 'Да, удалить'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteDocId(null)}
                                        className="text-[11px] text-slate-600 hover:text-slate-900 ml-1"
                                      >
                                        Отмена
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteDocId(doc.id)}
                                      className="px-2 py-0.5 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 inline-flex items-center gap-1"
                                      title="Удалить прикреплённое фото / файл"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      <span>Удалить</span>
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Optional custom WhatsApp message text */}
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Текст сообщения для WhatsApp (оставьте пустым для стандартного шаблона по договору):
                          </label>
                          <input
                            type="text"
                            value={customMessages[activeContract.id] || ''}
                            onChange={(e) =>
                              setCustomMessages((prev) => ({
                                ...prev,
                                [activeContract.id]: e.target.value,
                              }))
                            }
                            placeholder={`Здравствуйте, ${client.fullName}! Направляем информацию по вашему договору № ${activeContract.contractNumber}...`}
                            className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                          />
                        </div>

                        {/* Honest WhatsApp Click to Chat Status Banner */}
                        {waSession && (
                          <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-xs text-emerald-950 space-y-2">
                            <div className="font-semibold flex items-center gap-1.5">
                              <MessageCircle className="w-4 h-4 text-emerald-700" />
                              <span>{waSession.statusNotice}</span>
                            </div>
                            <p className="text-[11px] text-emerald-900">
                              Стандартная ссылка WhatsApp Click to Chat открывает диалог с номером{' '}
                              <strong className="font-mono">{waSession.normalizedPhone}</strong> и
                              подставляет готовый текст, но браузер не может автоматически вложить файл в чужое приложение без вашего подтверждения.
                            </p>
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <a
                                href={waSession.whatsappUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 inline-flex items-center gap-1.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Повторно открыть чат WhatsApp</span>
                              </a>
                              {waSession.selectedDocument && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!waSession.selectedDocument) return;
                                    try {
                                      await downloadProtectedFile(
                                        waSession.selectedDocument.downloadUrl,
                                        waSession.selectedDocument.originalFilename ||
                                          `${waSession.selectedDocument.id}.bin`
                                      );
                                    } catch (err) {
                                      setError(
                                        err instanceof Error
                                          ? err.message
                                          : 'Ошибка скачивания файла'
                                      );
                                    }
                                  }}
                                  className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 inline-flex items-center gap-1.5"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>
                                    Скачать файл «{waSession.selectedDocument.originalFilename}» для прикрепления
                                  </span>
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {previewDoc && (
        <DocumentPreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          fetchProtectedBlob={fetchProtectedBlob}
          downloadProtectedFile={downloadProtectedFile}
          onDeleteDocument={handleDeleteDocument}
        />
      )}
    </div>
  );
};

interface StatusRulesConfigCardProps {
  statusRules: StatusRulesConfigDTO;
  isOwner: boolean;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onRefresh: () => Promise<void>;
}

export const StatusRulesConfigCard: React.FC<StatusRulesConfigCardProps> = ({
  statusRules,
  isOwner,
  apiFetch,
  onRefresh,
}) => {
  const [gracePeriodDays, setGracePeriodDays] = useState(String(statusRules.gracePeriodDays));
  const [complexMinOverdueDays, setComplexMinOverdueDays] = useState(
    String(statusRules.complexMinOverdueDays)
  );
  const [complexConsecutiveMissedCount, setComplexConsecutiveMissedCount] = useState(
    String(statusRules.complexConsecutiveMissedCount)
  );
  const [complexMinOverdueRubles, setComplexMinOverdueRubles] = useState(
    String(Math.round(statusRules.complexMinOverdueKopecks / 100))
  );
  const [reliableMaxPastLateCount, setReliableMaxPastLateCount] = useState(
    String(statusRules.reliableMaxPastLateCount)
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch('/api/v1/settings/status-rules', {
        method: 'PUT',
        body: JSON.stringify({
          gracePeriodDays: Number(gracePeriodDays),
          complexMinOverdueDays: Number(complexMinOverdueDays),
          complexConsecutiveMissedCount: Number(complexConsecutiveMissedCount),
          complexMinOverdueKopecks: parseRublesInputToKopecks(complexMinOverdueRubles),
          reliableMaxPastLateCount: Number(reliableMaxPastLateCount),
        }),
      });
      await onRefresh();
      setMessage('Пороги автоматического расчёта статусов клиентов сохранены и пересчитаны.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Ошибка сохранения настроек статусов');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
        <ShieldCheck className="w-4 h-4 text-slate-800" />
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Правила и пороги автоматического определения статусов клиентов
          </h3>
          <p className="text-xs text-slate-500">
            Статусы («VIP», «Надёжный», «Под наблюдением», «Сложный», «Рассрочка закрыта») вычисляются автоматически из фактических платежей и графиков
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Льготный период до просрочки (дней)
            </label>
            <input
              type="number"
              min="0"
              max="30"
              disabled={!isOwner}
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Порог «Сложный»: дней просрочки от
            </label>
            <input
              type="number"
              min="1"
              max="365"
              disabled={!isOwner}
              value={complexMinOverdueDays}
              onChange={(e) => setComplexMinOverdueDays(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Порог «Сложный»: пропущено подряд от
            </label>
            <input
              type="number"
              min="1"
              max="24"
              disabled={!isOwner}
              value={complexConsecutiveMissedCount}
              onChange={(e) => setComplexConsecutiveMissedCount(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Порог «Сложный»: сумма просрочки (₽)
            </label>
            <input
              type="number"
              min="100"
              step="100"
              disabled={!isOwner}
              value={complexMinOverdueRubles}
              onChange={(e) => setComplexMinOverdueRubles(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Макс. прошлых задержек для «Надёжный»
            </label>
            <input
              type="number"
              min="1"
              max="50"
              disabled={!isOwner}
              value={reliableMaxPastLateCount}
              onChange={(e) => setReliableMaxPastLateCount(e.target.value)}
              className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div className="text-[11px] text-slate-500">
            Если у клиента несколько активных договоров, общий статус клиента отражает наиболее серьёзную текущую проблему.
          </div>
          {isOwner && (
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              {saving ? 'Сохранение...' : 'Сохранить пороги статусов'}
            </button>
          )}
        </div>
        {message && (
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800">
            {message}
          </div>
        )}
      </form>
    </div>
  );
};
