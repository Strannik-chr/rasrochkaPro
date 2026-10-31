# ==============================================================================
# РассрочкаПро — Production Dockerfile (Amvera / Render / Koyeb / VPS)
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# 1. Установка зависимостей
COPY package.json package-lock.json* ./
RUN npm ci

# 2. Копирование исходного кода и сборка фронтенда
COPY . .
RUN npm run build

# 3. Создание приватных каталогов (включая постоянное хранилище /data для Amvera Cloud)
RUN mkdir -p /data /data/uploads /data/backups /app/data /app/uploads /app/backups && \
    chmod 700 /data /data/uploads /data/backups /app/data /app/uploads /app/backups

ENV NODE_ENV=production
ENV PORT=3000
ENV SEED_DEMO_DATA=false
ENV SQLITE_STORAGE_PATH=/data/installment_ledger.sqlite
ENV PRIVATE_STORAGE_DIR=/data/uploads
ENV BACKUP_STORAGE_DIR=/data/backups

EXPOSE 3000

# Проверка работоспособности контейнера
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
