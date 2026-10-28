import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDb } from './src/server/db/database';
import { createApiRouter } from './src/server/routes/api';

function getAllowedOrigins(): Set<string> {
  const raw = [
    process.env.FRONTEND_ORIGIN || '',
    process.env.ALLOWED_ORIGINS || '',
    process.env.APP_URL || '',
  ]
    .join(',')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return new Set(raw);
}

export async function createAppServer(customDbPath?: string) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const db = getDb(customDbPath);
  const allowedOrigins = getAllowedOrigins();

  // Security headers & strict allowlist CORS middleware (iframe-compatible for preview environment)
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:;"
    );

    const requestOrigin = req.headers.origin ? String(req.headers.origin).replace(/\/+$/, '') : '';
    if (requestOrigin) {
      const hostOrigin = `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
      if (requestOrigin === hostOrigin || allowedOrigins.has(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, X-CSRF-Token, X-Session-Token, Idempotency-Key'
        );
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      } else if (req.path.startsWith('/api/')) {
        res.status(403).json({ error: 'Запрос с неразрешённого источника (CORS) отклонён.' });
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: '12mb' }));

  // Mount REST API v1
  app.use('/api/v1', createApiRouter(db));

  // Explicit 404 JSON response for any unknown /api/* route
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Запрошенный API-маршрут не найден.' });
  });

  // Global error handler — never expose internal stack traces or file paths in HTTP responses
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Размер передаваемых данных превышает допустимый лимит (12 МБ).' });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Некорректный формат JSON в теле запроса.' });
      return;
    }
    res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
  });

  return { app, db };
}

async function startServer() {
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (
      !process.env.SESSION_SECRET ||
      process.env.SESSION_SECRET === 'REPLACE_WITH_32_BYTE_HEX_SECRET_IN_PRODUCTION'
    ) {
      console.error('CRITICAL: Refusing to start in production with placeholder SESSION_SECRET.');
      process.exit(1);
    }
    if (
      !process.env.BACKUP_ENCRYPTION_KEY ||
      process.env.BACKUP_ENCRYPTION_KEY === 'REPLACE_WITH_64_HEX_CHARS_256_BIT_AES_GCM_KEY'
    ) {
      console.error('CRITICAL: Refusing to start in production with placeholder BACKUP_ENCRYPTION_KEY.');
      process.exit(1);
    }
  }

  const { app } = await createAppServer();

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[РассрочкаПро] Защищённый сервер запущен на http://0.0.0.0:${port}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Failed to start server:', err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  });
}

