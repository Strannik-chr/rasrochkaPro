# ==============================================================================
# РассрочкаПро — Production Dockerfile (Amvera / Render / Koyeb / VPS)
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# Увеличенный лимит памяти для сборки крупного фронтенд-бандла (Vite / Rolldown)
ENV NODE_OPTIONS="--max-old-space-size=2048"

# 1. Установка зависимостей (независимо от старого package-lock.json и NODE_ENV сборщика)
COPY package.json ./
RUN NODE_ENV=development npm install --include=dev --legacy-peer-deps --no-audit --no-fund

# 2. Копирование исходного кода и сборка фронтенда
COPY . .
RUN npm run build

# 3. Создание рабочих каталогов для хранения данных
RUN mkdir -p /data /data/uploads /data/backups /app/data /app/uploads /app/backups

ENV NODE_ENV=production
ENV PORT=3000
ENV SEED_DEMO_DATA=false
ENV SQLITE_STORAGE_PATH=/data/installment_ledger.sqlite
ENV PRIVATE_STORAGE_DIR=/data/uploads
ENV BACKUP_STORAGE_DIR=/data/backups

EXPOSE 3000

CMD ["node", "server.ts"]
