import React, { useState } from 'react';
import {
  ClientDTO,
  ContractDTO,
  FinancialAccountDTO,
  PaymentDTO,
} from '../shared/types';
import {
  formatDateRu,
  formatMoney,
  parseRublesInputToKopecks,
  translateScheduleStatus,
} from '../utils/format';
import { X, AlertTriangle, Check } from 'lucide-react';

interface ManualAllocationModalProps {
  payment: PaymentDTO;
  contracts: ContractDTO[];
  onClose: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onSuccess: () => Promise<void>;
}

export const ManualAllocationModal: React.FC<ManualAllocationModalProps> = ({
  payment,
  contracts,
  onClose,
  apiFetch,
  onSuccess,
}) => {
  const clientContracts = contracts.filter(
    (c) => c.clientId === payment.clientId && (c.status === 'active' || c.status === 'restructured')
  );
  const [selectedContractId, setSelectedContractId] = useState<string>(
    payment.contractId || clientContracts[0]?.id || ''
  );
  const [allocMap, setAllocMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedContract = contracts.find((c) => c.id === selectedContractId);
  const unpaidItems = (selectedContract?.schedule || []).filter((i) => i.remainingKopecks > 0);

  const totalSelectedKopecks = Object.values(allocMap).reduce<number>(
    (sum, val) => sum + parseRublesInputToKopecks(String(val)),
    0
  );
  const remainingUnallocatedAfter = payment.unallocatedKopecks - totalSelectedKopecks;

  const handleQuickFillItem = (itemId: string, itemRemainingKopecks: number) => {
    const currentOnThis = parseRublesInputToKopecks(allocMap[itemId] || '0');
    const availableToAdd = Math.max(0, remainingUnallocatedAfter + currentOnThis);
    const fillKop = Math.min(itemRemainingKopecks, availableToAdd);
    setAllocMap((prev) => ({
      ...prev,
      [itemId]: (fillKop / 100).toFixed(2),
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totalSelectedKopecks <= 0) {
      setError('Укажите сумму распределения хотя бы по одному платежу графика.');
      return;
    }
    if (totalSelectedKopecks > payment.unallocatedKopecks) {
      setError('Сумма распределения превышает доступный нераспределённый остаток поступления.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const allocations = Object.entries(allocMap)
        .map(([scheduleItemId, rubStr]) => ({
          scheduleItemId,
          amountKopecks: parseRublesInputToKopecks(String(rubStr)),
        }))
        .filter((a) => a.amountKopecks > 0);

      await apiFetch(`/api/v1/payments/${payment.id}/allocate`, {
        method: 'POST',
        body: JSON.stringify({
          contractId: selectedContractId,
          allocations,
        }),
      });
      await onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка распределения платежа');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Ручное распределение платежа · {payment.clientName}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Система не распределяет частичные платежи автоматически. Выберите договор и конкретные строки графика
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
          <div>
            <div className="text-slate-500">Сумма поступления</div>
            <div className="text-sm font-semibold font-mono text-slate-900 mt-0.5">
              {formatMoney(payment.amountKopecks)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Доступно к распределению</div>
            <div className="text-sm font-semibold font-mono text-amber-700 mt-0.5">
              {formatMoney(payment.unallocatedKopecks)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Останется нераспределённым</div>
            <div
              className={`text-sm font-semibold font-mono mt-0.5 ${
                remainingUnallocatedAfter < 0 ? 'text-red-600' : 'text-emerald-700'
              }`}
            >
              {formatMoney(remainingUnallocatedAfter)}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Выберите договор клиента для направления средств
            </label>
            <select
              value={selectedContractId}
              onChange={(e) => {
                setSelectedContractId(e.target.value);
                setAllocMap({});
              }}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {clientContracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contractNumber} — {c.itemTitle} (Остаток долга: {formatMoney(c.remainingDebtKopecks)})
                </option>
              ))}
            </select>
          </div>

          {selectedContract && (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-3 font-medium">Платёж графика</th>
                    <th className="py-2.5 px-3 font-medium">Срок</th>
                    <th className="py-2.5 px-3 font-medium text-right">Остаток по строке</th>
                    <th className="py-2.5 px-3 font-medium text-right">Направить сумму (₽)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {unpaidItems.map((item) => (
                    <tr key={item.id}>
                      <td className="py-2 px-3">
                        <span className="font-mono font-medium text-slate-900">
                          №{item.installmentNumber}
                        </span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-600">
                          {translateScheduleStatus(item.status)}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-700">
                        {formatDateRu(item.dueDate)}
                        {item.daysOverdue > 0 && (
                          <span className="text-red-600 ml-1.5">
                            (просрочка {item.daysOverdue} дн.)
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                        {formatMoney(item.remainingKopecks)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max={item.remainingKopecks / 100}
                            placeholder="0.00"
                            value={allocMap[item.id] || ''}
                            onChange={(e) =>
                              setAllocMap((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            className="w-28 px-2.5 py-1 text-xs font-mono text-right border border-slate-300 rounded-lg"
                          />
                          <button
                            type="button"
                            onClick={() => handleQuickFillItem(item.id, item.remainingKopecks)}
                            className="px-2 py-1 text-[11px] text-slate-700 border border-slate-200 rounded hover:bg-slate-100 whitespace-nowrap"
                          >
                            Заполнить
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {unpaidItems.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-500">
                        По данному договору все платежи графика уже погашены.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting || totalSelectedKopecks <= 0 || remainingUnallocatedAfter < 0}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>
                {submitting
                  ? 'Сохранение...'
                  : `Распределить ${formatMoney(totalSelectedKopecks)}`}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface NewPaymentModalProps {
  clients: ClientDTO[];
  contracts: ContractDTO[];
  accounts: FinancialAccountDTO[];
  onClose: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onSuccess: () => Promise<void>;
}

export const NewPaymentModal: React.FC<NewPaymentModalProps> = ({
  clients,
  contracts,
  accounts,
  onClose,
  apiFetch,
  onSuccess,
}) => {
  const [clientId, setClientId] = useState(clients[0]?.id || '');
  const [contractId, setContractId] = useState<string>('');
  const [accountId, setAccountId] = useState(accounts[0]?.id || 'acc_bank_main');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank_transfer'>('bank_transfer');
  const [amountRubles, setAmountRubles] = useState('');
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [allocMap, setAllocMap] = useState<Record<string, string>>({});
  const [idempotencyKey] = useState(() => `idem_pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const clientContracts = contracts.filter(
    (c) => c.clientId === clientId && (c.status === 'active' || c.status === 'restructured')
  );
  const selectedContract = contracts.find((c) => c.id === contractId);
  const unpaidItems = (selectedContract?.schedule || []).filter((i) => i.remainingKopecks > 0);

  const amountKopecks = parseRublesInputToKopecks(amountRubles);
  const allocatedKopecks = Object.values(allocMap).reduce<number>(
    (sum, v) => sum + parseRublesInputToKopecks(String(v)),
    0
  );
  const unallocatedAfter = amountKopecks - allocatedKopecks;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amountKopecks <= 0) {
      setError('Введите сумму поступления больше 0 ₽.');
      return;
    }
    if (allocatedKopecks > amountKopecks) {
      setError('Сумма распределения по строкам графика не может превышать сумму поступления.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const allocations = Object.entries(allocMap)
        .map(([scheduleItemId, rub]) => ({
          scheduleItemId,
          amountKopecks: parseRublesInputToKopecks(String(rub)),
        }))
        .filter((a) => a.amountKopecks > 0);

      await apiFetch('/api/v1/payments', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey,
          clientId,
          contractId: contractId || null,
          accountId,
          paymentMethod,
          amountKopecks,
          eventDate,
          notes,
          allocations,
        }),
      });
      await onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка регистрации платежа');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Регистрация поступления от клиента
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Ключ защиты от двойного проведения: <span className="font-mono">{idempotencyKey}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Клиент *</label>
              <select
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setContractId('');
                  setAllocMap({});
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {clients.map((cl) => (
                  <option key={cl.id} value={cl.id}>
                    {cl.fullName} ({cl.phone})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Договор (можно оставить пустым, если перевод без назначения)
              </label>
              <select
                value={contractId}
                onChange={(e) => {
                  setContractId(e.target.value);
                  setAllocMap({});
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">
                  — Без указания договора (сохранить как нераспределённое поступление) —
                </option>
                {clientContracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contractNumber} — {c.itemTitle} (долг: {formatMoney(c.remainingDebtKopecks)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Сумма поступления (₽) *
              </label>
              <input
                type="number"
                step="0.01"
                min="1"
                value={amountRubles}
                onChange={(e) => setAmountRubles(e.target.value)}
                placeholder="Например: 11841.66"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Касса / Банковский счёт *
              </label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Способ оплаты</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as 'cash' | 'bank_transfer')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="bank_transfer">Банковский перевод / СБП</option>
                <option value="cash">Наличные в кассу</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Дата операции</label>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Комментарий / Назначение платежа
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Например: Оплата переводом от клиента по графику"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {selectedContract && amountKopecks > 0 && (
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">
                  Ручной выбор платежей графика ({selectedContract.contractNumber})
                </span>
                <span className="font-mono text-slate-700">
                  Распределено: {formatMoney(allocatedKopecks)} · Нераспределённый остаток:{' '}
                  <strong className={unallocatedAfter < 0 ? 'text-red-600' : 'text-emerald-700'}>
                    {formatMoney(unallocatedAfter)}
                  </strong>
                </span>
              </div>

              <table className="w-full text-left text-xs bg-white border border-slate-200 rounded-lg overflow-hidden">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2 px-3">№</th>
                    <th className="py-2 px-3">Дата по графику</th>
                    <th className="py-2 px-3 text-right">Остаток по строке</th>
                    <th className="py-2 px-3 text-right">Направить сумму (₽)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {unpaidItems.map((item) => (
                    <tr key={item.id}>
                      <td className="py-1.5 px-3 font-mono">№{item.installmentNumber}</td>
                      <td className="py-1.5 px-3 font-mono">{formatDateRu(item.dueDate)}</td>
                      <td className="py-1.5 px-3 font-mono text-right">
                        {formatMoney(item.remainingKopecks)}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={allocMap[item.id] || ''}
                            onChange={(e) =>
                              setAllocMap((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            className="w-28 px-2 py-1 text-xs font-mono text-right border border-slate-300 rounded"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const curr = parseRublesInputToKopecks(allocMap[item.id] || '0');
                              const avail = Math.max(0, unallocatedAfter + curr);
                              const fill = Math.min(item.remainingKopecks, avail);
                              setAllocMap((prev) => ({
                                ...prev,
                                [item.id]: (fill / 100).toFixed(2),
                              }));
                            }}
                            className="px-2 py-1 text-[11px] border border-slate-200 rounded hover:bg-slate-50"
                          >
                            Макс.
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting || unallocatedAfter < 0}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? 'Проведение...' : 'Зарегистрировать платёж'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
