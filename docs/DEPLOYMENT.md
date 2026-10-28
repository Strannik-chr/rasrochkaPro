# Руководство по развёртыванию в Production (Бюджет 0 ₽ / месяц) — РассрочкаПро

Настоящая инструкция описывает как запуск приложения в качестве единого защищённого сервиса (Node.js 22 + встроенная БД SQLite WAL или внешний PostgreSQL), так и развёртывание на бесплатных облачных платформах для работы с компьютера и смартфона через интернет.

---

## 1. Рекомендуемая архитектура с бюджетом 0 ₽ / месяц

Приложение спроектировано как **модульный монолит**, что позволяет развернуть его двумя способами:

### Вариант А (Рекомендуемый для единого контейнера / VPS / Fly.io / Render / Railway):
- **Единый сервис (Backend API + собранный Frontend SPA из `dist/`)**:
  - Сервер Express (`server.ts`) отдаёт статику фронтенда и обрабатывает `/api/v1/*` на одном домене (Same-Origin).
  - Преимущество: отсутствие кросс-доменных задержек, работа `HttpOnly` cookie и `X-CSRF-Token` на одном домене, мгновенные транзакции.
- **Хранение данных**:
  - Постоянный том (Persistent Volume) для `./data/installment_ledger.sqlite` и `./uploads/` + автоматическая выгрузка зашифрованных копий `AES-256-GCM` (`./backups/`), либо подключение управляемой бесплатной PostgreSQL (Supabase / Neon) со схемами из `/migrations/001_init_postgres.sql` — `003_production_hardening.sql`.

### Вариант Б (Раздельное облачное размещение Free Tier):
- **Frontend**: **Cloudflare Pages** (бесплатный тариф, глобальный CDN, автоматический HTTPS).
  - Команда сборки: `npm run build`
  - Директория публикации: `dist`
- **Backend API**: **Render Free Web Service** или **Koyeb Free Tier**.
  - Команда сборки: `npm ci`
  - Команда запуска: `npm start`
  - Переменная `ALLOWED_ORIGINS`: URL вашего домена на Cloudflare Pages (например, `https://rassrochka-pro.pages.dev`).
- **База данных**: **Supabase Free Tier** или **Neon Serverless Postgres** (0 ₽/мес, до 500 МБ — достаточно для десятков тысяч договоров и платежей).
- **Объектное хранилище документов**: **Cloudflare R2** (0 ₽/мес до 10 ГБ, без платы за исходящий трафик) или приватное хранилище сервера `./uploads`.
- **Мониторинг доступности (Keep-Alive & Alerts)**: **UptimeRobot** (бесплатный HTTP-монитор каждые 5 минут на `GET https://<ваш-домен>/api/v1/health`).

---

## 2. Пошаговая подготовка перед запуском в Production

### Шаг 1. Генерация криптографических секретов
Выполните в терминале:
```bash
openssl rand -hex 32
# Скопируйте первое значение в SESSION_SECRET
openssl rand -hex 32
# Скопируйте второе значение в BACKUP_ENCRYPTION_KEY
```
> **Важно**: В режиме `NODE_ENV=production` сервер принудительно завершит запуск с ошибкой, если `SESSION_SECRET` или `BACKUP_ENCRYPTION_KEY` не заданы или равны шаблонным значениям из `.env.example`.

### Шаг 2. Настройка переменных окружения
Задайте на платформе хостинга следующие переменные окружения:
```env
NODE_ENV=production
PORT=3000
APP_URL=https://ваш-домен.ru
FRONTEND_ORIGIN=https://ваш-домен.ru
ALLOWED_ORIGINS=https://ваш-домен.ru
SESSION_SECRET=<64_символа_hex>
BACKUP_ENCRYPTION_KEY=<64_символа_hex>
SEED_DEMO_DATA=false
SQLITE_STORAGE_PATH=./data/installment_ledger.sqlite
PRIVATE_STORAGE_DIR=./uploads
```

### Шаг 3. Сборка и проверка перед выкладкой
```bash
npm ci
npm run lint
npm test
npm run build
```

### Шаг 4. Создание учётной записи владельца (первого администратора)
После первого запуска на чистой базе (`SEED_DEMO_DATA=false`) создайте или обновите пароль владельца через консоль сервера:
```bash
npm run create-admin -- --phone "+79285550101" --password "ВашСложныйПароль!2026" --name "Мо (Владелец)"
```

### Шаг 5. Проверка работоспособности после развёртывания
1. Проверьте технический healthcheck:
   ```bash
   curl -i https://ваш-домен.ru/api/v1/health
   ```
   Ожидаемый ответ: `HTTP/1.1 200 OK` и JSON:
   ```json
   {
     "status": "ok",
     "dbConnected": true,
     "reconciliationHealthy": true,
     "storageMode": "local_private"
   }
   ```
2. Откройте `https://ваш-домен.ru` с компьютера и со смартфона.
3. Войдите по номеру телефона и паролю администратора.
4. Перейдите в раздел **«14. Безопасность и бэкапы»**, нажмите **«Создать резервную копию»** и **«Скачать»**, чтобы сохранить первую эталонную копию чистой базы.

---

## 3. Применение миграций для PostgreSQL (Supabase / Neon)

Если вы разворачиваете схему во внешней БД PostgreSQL, выполните миграции по порядку:
```bash
psql "$DATABASE_URL" -f migrations/001_init_postgres.sql
psql "$DATABASE_URL" -f migrations/002_phone_auth_hardening.sql
psql "$DATABASE_URL" -f migrations/003_production_hardening.sql
```
Все три миграции идемпотентны (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) и выполняются внутри транзакций `BEGIN ... COMMIT`.
