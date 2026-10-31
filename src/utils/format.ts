export function formatMoney(kopecks: number | null | undefined): string {
  if (kopecks === null || kopecks === undefined || Number.isNaN(kopecks)) {
    return '0,00\u00A0₽';
  }
  const sign = kopecks < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(kopecks));
  const rubles = Math.floor(abs / 100);
  const kop = abs % 100;
  const formattedRubles = rubles.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${sign}${formattedRubles},${String(kop).padStart(2, '0')}\u00A0₽`;
}

export function parseRublesInputToKopecks(raw: string): number {
  const cleaned = raw.replace(/\s+/g, '').replace(',', '.');
  if (!cleaned) return 0;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100);
}

export function formatDateRu(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const slice = isoDate.slice(0, 10);
  const parts = slice.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

export function formatDateTimeRu(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function translateRoundingRule(rule: string): string {
  switch (rule) {
    case 'kopeck':
      return 'До копейки (корректировка последнего платежа)';
    case 'ruble':
      return 'До целого рубля (остаток в последнем платеже)';
    case 'ten_rubles':
      return 'Кратно 10 ₽ (остаток в последнем платеже)';
    default:
      return rule;
  }
}

export function translateContractStatus(status: string): string {
  switch (status) {
    case 'active':
      return 'Действует';
    case 'completed':
      return 'Исполнен (закрыт)';
    case 'restructured':
      return 'Реструктурирован';
    case 'returned':
      return 'Возврат товара';
    case 'cancelled':
      return 'Расторгнут';
    case 'draft':
      return 'Черновик';
    default:
      return status;
  }
}

export function translateScheduleStatus(status: string): string {
  switch (status) {
    case 'paid':
      return 'Оплачен';
    case 'partial':
      return 'Частично оплачен';
    case 'overdue':
      return 'Просрочен';
    case 'pending':
      return 'Ожидает оплаты';
    case 'waived':
      return 'Списан (скидка при досрочном)';
    case 'superseded':
      return 'Архивная версия';
    default:
      return status;
  }
}

export function translateEntryType(type: string): string {
  switch (type) {
    case 'client_payment':
      return 'Поступление от клиента';
    case 'purchase_payment':
      return 'Оплата закупки поставщику';
    case 'delivery_expense':
      return 'Доставка и прямые затраты';
    case 'operating_expense':
      return 'Операционный расход';
    case 'owner_injection':
      return 'Внесение собственных средств владельца';
    case 'owner_withdrawal':
      return 'Личное изъятие владельца';
    case 'internal_transfer_out':
      return 'Внутренний перевод (списание)';
    case 'internal_transfer_in':
      return 'Внутренний перевод (зачисление)';
    case 'client_refund':
      return 'Возврат средств клиенту';
    case 'supplier_refund':
      return 'Возврат от поставщика';
    default:
      return type;
  }
}

export function getClientPaymentStatusMeta(status?: string): {
  label: string;
  badgeClass: string;
  dotClass: string;
  description: string;
} {
  switch (status) {
    case 'vip':
      return {
        label: 'VIP',
        badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        dotClass: 'bg-emerald-600',
        description: 'Своевременно оплачивает все действующие рассрочки, просрочек нет',
      };
    case 'reliable':
      return {
        label: 'Надёжный',
        badgeClass: 'bg-sky-50 text-sky-800 border-sky-200',
        dotClass: 'bg-sky-600',
        description: 'Соблюдает график платежей, существенной задолженности нет',
      };
    case 'watch':
      return {
        label: 'Под наблюдением',
        badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
        dotClass: 'bg-amber-500',
        description: 'Имеется текущая просрочка, которую необходимо контролировать',
      };
    case 'complex':
      return {
        label: 'Сложный',
        badgeClass: 'bg-red-50 text-red-800 border-red-200',
        dotClass: 'bg-red-600',
        description: 'Длительная просрочка, несколько пропущенных платежей подряд или крупный долг',
      };
    case 'closed':
      return {
        label: 'Рассрочка закрыта',
        badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
        dotClass: 'bg-slate-500',
        description: 'Все договорные обязательства полностью выполнены',
      };
    case 'new':
    default:
      return {
        label: 'Новый клиент',
        badgeClass: 'bg-slate-50 text-slate-600 border-slate-200',
        dotClass: 'bg-slate-400',
        description: 'Ещё нет активных или завершённых договоров рассрочки',
      };
  }
}

export function getClientStatusSortWeight(status?: string): number {
  switch (status) {
    case 'complex':
      return 1;
    case 'watch':
      return 2;
    case 'reliable':
      return 3;
    case 'vip':
      return 4;
    case 'closed':
      return 5;
    case 'new':
    default:
      return 6;
  }
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

