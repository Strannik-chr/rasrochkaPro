# ==============================================================================
# РассрочкаПро — Production Dockerfile (Render / Koyeb / Railway / Fly.io / VPS)
# ==============================================================================
FROM node:22-slim

WORKDIR /app

# 1. Установка зависимостей
COPY package.json package-lock.json* ./
RUN npm ci

# 2. Копирование исходного кода и сборка фронтенда
COPY . .
RUN npm run build

# 3. Создание приватных каталогов для БД, документов и зашифрованных копий
RUN mkdir -p /app/data /app/uploads /app/backups && \
    chmod 700 /app/data /app/uploads /app/backups

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Проверка работоспособности контейнера
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
