# API_SPEC.md — Спецификация REST API и правила авторизации

Все эндпоинты имеют префикс `/api/v1`.
Аутентификация осуществляется через серверную сессию в cookie `rp_session` (`HttpOnly`, `SameSite=Lax`, `Secure` в production).
Для всех изменяющих состояние запросов (`POST`, `PUT`, `PATCH`, `DELETE`), кроме первичной подачи заявки и входа, обязателен заголовок `X-CSRF-Token`.

## 1. Аутентификация и Регистрация (`/api/v1/auth`)
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `GET` | `/api/v1/auth/session` | Public / Auth | Возвращает текущего пользователя, активный `csrfToken` и статус MFA |
| `POST` | `/api/v1/auth/register-request` | Public (Rate-limited) | Подача заявки на регистрацию (`email`, `fullName`, `phone`, `password`). Создаёт пользователя со статусом `pending_email` и генерирует одноразовый код |
| `POST` | `/api/v1/auth/verify-email` | Public (Rate-limited) | Подтверждение email одноразовым 6-значным кодом (`email`, `code`). Переводит заявку в статус `pending_approval` (доступ к данным не открывается до одобрения владельцем) |
| `POST` | `/api/v1/auth/login` | Public (Rate-limited) | Вход по `email`, `password` и опциональному `totpCode` (если у владельца включён TOTP MFA). Ротирует сессию |
| `POST` | `/api/v1/auth/logout` | Auth | Инвалидация текущей сессии и очистка cookie |
| `POST` | `/api/v1/auth/mfa/setup` | `owner` | Генерация секрета TOTP MFA и URI для приложения-аутентификатора |
| `POST` | `/api/v1/auth/mfa/enable` | `owner` | Подтверждение включения TOTP MFA проверочным кодом |

## 2. Управление пользователями и сессиями (`/api/v1/users`)
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `GET` | `/api/v1/users` | `owner` | Список всех пользователей, заявок на одобрение и активных сессий |
| `POST` | `/api/v1/users/:id/approve` | `owner` | Одобрение заявки (`role`: `'staff' | 'readonly'`) |
| `POST` | `/api/v1/users/:id/reject` | `owner` | Отклонение заявки на регистрацию |
| `POST` | `/api/v1/users/:id/role` | `owner` | Изменение роли пользователя с записью в аудит |
| `POST` | `/api/v1/users/:id/block` | `owner` | Блокировка пользователя и немедленный отзыв всех его сессий |
| `POST` | `/api/v1/users/:id/revoke-sessions` | `owner` | Принудительный выход пользователя со всех устройств |

## 3. Гибкие настройки рассрочки (`/api/v1/settings`)
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `GET` | `/api/v1/settings` | `owner`, `staff`, `readonly` | Получение активных и архивных тарифов рассрочки, правил округления и истории изменений |
| `POST` | `/api/v1/settings/plans` | `owner` | Добавление нового срока/тарифа рассрочки |
| `PUT` | `/api/v1/settings/plans/:id` | `owner` | Обновление тарифа (увеличивает `version`, сохраняет старое и новое значение в `settings_history`, не затрагивает существующие договоры) |
| `POST` | `/api/v1/settings/plans/:id/toggle` | `owner` | Включение/отключение срока рассрочки |

## 4. Клиенты, Поставщики и Закупки
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `GET` | `/api/v1/clients` | `owner`, `staff`, `readonly` | Список клиентов с расчётом текущего долга и просрочки |
| `POST` | `/api/v1/clients` | `owner`, `staff` | Создание карточки клиента |
| `PUT` | `/api/v1/clients/:id` | `owner`, `staff` | Обновление данных клиента |
| `GET` | `/api/v1/suppliers` | `owner`, `staff`, `readonly` | Справочник магазинов и поставщиков с балансом обязательств |
| `POST` | `/api/v1/suppliers` | `owner`, `staff` | Добавление поставщика / магазина |
| `GET` | `/api/v1/purchases` | `owner`, `staff`, `readonly` | Реестр закупок и товаров |
| `POST` | `/api/v1/purchases` | `owner`, `staff` | Регистрация закупки товара (с расчётом полной себестоимости и проводкой оплаты поставщику при необходимости) |
| `POST` | `/api/v1/purchases/:id/handover` | `owner`, `staff` | Изменение статуса передачи товара клиенту / возврата |

## 5. Договоры, Расчёты и Графики (`/api/v1/contracts`)
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `POST` | `/api/v1/contracts/preview` | `owner`, `staff`, `readonly` | Предварительный расчёт договора и графика платежей без сохранения в БД |
| `POST` | `/api/v1/contracts` | `owner`, `staff` | Оформление и активация договора после подтверждения расчёта |
| `GET` | `/api/v1/contracts` | `owner`, `staff`, `readonly` | Список договоров с текущими версиями графиков и историей |
| `POST` | `/api/v1/contracts/:id/early-payoff-preview` | `owner`, `staff`, `readonly` | Расчёт 4 вариантов досрочного погашения |
| `POST` | `/api/v1/contracts/:id/early-payoff-apply` | `owner` | Утверждение владельцем выбранного варианта досрочного закрытия |
| `POST` | `/api/v1/contracts/:id/restructure` | `owner` | Создание новой версии графика платежей с сохранением предыдущей версии в истории |
| `POST` | `/api/v1/contracts/:id/return` | `owner` | Оформление возврата товара / расторжения договора |

## 6. Платежи, Ручное Распределение и Просрочки (`/api/v1/payments`, `/api/v1/overdues`)
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `POST` | `/api/v1/payments` | `owner`, `staff` | Регистрация поступления от клиента (`Idempotency-Key` обязателен; может быть без договора — как нераспределённый платёж, либо сразу с выбранными строками графика) |
| `POST` | `/api/v1/payments/:id/allocate` | `owner`, `staff` | Ручное распределение доступного остатка платежа по конкретным строкам графика |
| `POST` | `/api/v1/payments/:id/reverse` | `owner` | Сторнирование ошибочного платежа с указанием причины и возвратом сумм в графике |
| `POST` | `/api/v1/overdues/contact` | `owner`, `staff` | Фиксация контакта с клиентом по просрочке, установка `promised_date` или согласованного переноса даты |

## 7. Касса, Банк, Отчёты, Документы и Безопасность
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| `POST` | `/api/v1/finance/ledger` | `owner`, `staff` | Проведение кассовой/банковской операции (расход, пополнение владельцем, изъятие, внутренний перевод) |
| `POST` | `/api/v1/finance/ledger/:id/reverse` | `owner` | Сторнирование денежной операции |
| `GET` | `/api/v1/finance/reconcile` | `owner`, `staff`, `readonly` | Автоматическая сверка денежных регистров, платежей и графиков |
| `GET` | `/api/v1/reports` | `owner`, `staff`, `readonly` | Агрегированные отчёты за выбранный период (`from`, `to`) |
| `GET` | `/api/v1/reports/export/csv` | `owner`, `staff`, `readonly` | Безопасный экспорт в CSV/Excel с защитой от Formula Injection |
| `POST` | `/api/v1/documents/upload` | `owner`, `staff` | Защищённая загрузка файла (проверка MIME и сигнатуры magic bytes) |
| `POST` | `/api/v1/security/backups` | `owner` | Создание зашифрованной резервной копии (AES-256-GCM) |
| `POST` | `/api/v1/security/backups/:id/verify` | `owner` | Проверка расшифровки, контрольной суммы SHA-256 и целостности регистров |
