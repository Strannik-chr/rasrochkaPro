import express, { Request, Response, NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { withTransaction } from '../db/database';
import {
  assertKopecks,
  calculateContractAndSchedule,
  calculateDaysOverdue,
  calculateEarlyPayoffComparison,
  calculateTotalCostKopecks,
  formatRubles,
  toSafeCsvRow,
} from '../finance/calculator';
import {
  generateSecureToken,
  generateTotpSecret,
  hashPassword,
  normalizeRussianPhone,
  safeCompareStrings,
  sha256Hex,
  validateUploadedFileSignature,
  verifyPassword,
  verifyPasswordConstantTime,
  verifyTotpCode,
  computeTotpCode,
} from '../security/crypto';
import {
  createEncryptedBackup,
  getBackupEnvelopeFile,
  reconcileFinance,
  recordAudit,
  restoreEncryptedBackup,
  restoreEncryptedBackupFromEnvelope,
  verifyEncryptedBackup,
} from '../services/reconciliationAndBackup';
import {
  getStorageStatus,
  readPrivateDocumentBuffer,
  removePrivateDocumentFile,
  writePrivateDocumentBuffer,
} from '../services/storage';
import { RoundingRule, ScheduleType, UserRole, UserStatus } from '../../shared/types';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    phone: string;
    fullName: string;
    role: UserRole;
    status: string;
    mustChangePassword: boolean;
    mfaEnabled: boolean;
  };
  sessionTokenHash?: string;
  csrfToken?: string;
}

const SESSION_COOKIE_NAME = 'rp_session';

// Configurable security thresholds (via environment variables with safe defaults)
export function getAuthSecurityConfig() {
  return {
    accountMaxAttempts: Number(process.env.AUTH_ACCOUNT_MAX_ATTEMPTS || 5),
    accountWindowMs: Number(process.env.AUTH_ACCOUNT_WINDOW_MS || 15 * 60 * 1000),
    accountLockoutMs: Number(process.env.AUTH_ACCOUNT_LOCKOUT_MS || 15 * 60 * 1000),
    ipMaxAttempts: Number(process.env.AUTH_IP_MAX_ATTEMPTS || 15),
    ipWindowMs: Number(process.env.AUTH_IP_WINDOW_MS || 15 * 60 * 1000),
    ipLockoutMs: Number(process.env.AUTH_IP_LOCKOUT_MS || 15 * 60 * 1000),
    globalMaxPerMin: Number(process.env.AUTH_GLOBAL_MAX_PER_MIN || 120),
    sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000),
    sessionMaxLifetimeMs: Number(process.env.SESSION_MAX_LIFETIME_MS || 12 * 60 * 60 * 1000),
  };
}

function getSafeClientIp(req: Request): string {
  // Rely on Express req.ip (which respects app.set('trust proxy', 1)) rather than untrusted raw headers
  const testIpHeader = process.env.NODE_ENV === 'test' ? req.headers['x-test-client-ip'] : undefined;
  if (typeof testIpHeader === 'string' && testIpHeader.trim()) {
    return testIpHeader.trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

function getEffectiveNowMs(req: Request): number {
  if (process.env.NODE_ENV === 'test') {
    const simulatedNow = req.headers['x-test-now-ms'];
    if (typeof simulatedNow === 'string' && /^\d+$/.test(simulatedNow)) {
      return Number(simulatedNow);
    }
  }
  return Date.now();
}

/**
 * Atomic persistent rate-limit check & increment in SQLite (with BEGIN IMMEDIATE TRANSACTION).
 * Ensures concurrent requests cannot bypass limits and works across workers sharing the DB.
 */
function checkRateLimitBucket(
  db: DatabaseSync,
  bucketKey: string,
  nowMs: number
): { locked: boolean; failures: number; lockedUntil: string | null } {
  const nowIso = new Date(nowMs).toISOString();
  const row = db
    .prepare('SELECT failures, window_started_at, locked_until FROM auth_rate_limits WHERE bucket_key = ?')
    .get(bucketKey) as
    | { failures: number; window_started_at: string; locked_until: string | null }
    | undefined;

  if (!row) {
    return { locked: false, failures: 0, lockedUntil: null };
  }
  if (row.locked_until && row.locked_until > nowIso) {
    return { locked: true, failures: row.failures, lockedUntil: row.locked_until };
  }
  return { locked: false, failures: row.failures, lockedUntil: null };
}

function incrementRateLimitBucket(
  db: DatabaseSync,
  bucketKey: string,
  maxAttempts: number,
  windowMs: number,
  lockoutMs: number,
  nowMs: number
): { lockedNow: boolean; failures: number; lockedUntil: string | null } {
  const nowIso = new Date(nowMs).toISOString();
  const row = db
    .prepare('SELECT failures, window_started_at, locked_until FROM auth_rate_limits WHERE bucket_key = ?')
    .get(bucketKey) as
    | { failures: number; window_started_at: string; locked_until: string | null }
    | undefined;

  let failures = 1;
  let windowStartedAt = nowIso;
  let lockedUntil: string | null = null;

  if (row) {
    const windowStartMs = Date.parse(row.window_started_at);
    const lockExpired = row.locked_until && row.locked_until <= nowIso;
    const windowExpired = Number.isNaN(windowStartMs) || nowMs - windowStartMs >= windowMs;

    if (lockExpired || windowExpired) {
      failures = 1;
      windowStartedAt = nowIso;
      lockedUntil = null;
    } else {
      failures = row.failures + 1;
      windowStartedAt = row.window_started_at;
      lockedUntil = row.locked_until;
    }
  }

  if (failures >= maxAttempts) {
    lockedUntil = new Date(nowMs + lockoutMs).toISOString();
  }

  db.prepare(
    `INSERT INTO auth_rate_limits (bucket_key, failures, window_started_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       failures = excluded.failures,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`
  ).run(bucketKey, failures, windowStartedAt, lockedUntil, nowIso);

  return { lockedNow: Boolean(lockedUntil && lockedUntil > nowIso), failures, lockedUntil };
}

function resetRateLimitBucket(db: DatabaseSync, bucketKey: string): void {
  db.prepare('DELETE FROM auth_rate_limits WHERE bucket_key = ?').run(bucketKey);
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      result[k] = v;
    }
  }
  return result;
}

function setSessionCookie(req: Request, res: Response, rawToken: string): void {
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';
  const maxAgeSec = 60 * 60 * 12; // 12 hours
  const flags = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) {
    flags.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    flags.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

export function createApiRouter(db: DatabaseSync): express.Router {
  const router = express.Router();

  function createSessionForUser(
    req: Request,
    res: Response,
    userId: string,
    nowMs = getEffectiveNowMs(req)
  ): {
    rawToken: string;
    csrfToken: string;
  } {
    const cfg = getAuthSecurityConfig();
    const rawToken = generateSecureToken(32);
    const tokenHash = sha256Hex(rawToken);
    const csrfToken = generateSecureToken(24);
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + cfg.sessionMaxLifetimeMs).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip_address, user_agent, last_active_at, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      crypto.randomUUID(),
      userId,
      tokenHash,
      csrfToken,
      getSafeClientIp(req),
      String(req.headers['user-agent'] || 'browser').slice(0, 200),
      nowIso,
      expiresAt,
      nowIso
    );

    setSessionCookie(req, res, rawToken);
    return { rawToken, csrfToken };
  }

  // Attach session from HttpOnly cookie OR in-memory X-Session-Token header (for browsers blocking 3P cookies in iframes)
  router.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = req.headers['x-session-token'];
    const rawToken =
      cookies[SESSION_COOKIE_NAME] ||
      (Array.isArray(headerToken) ? headerToken[0] : headerToken);

    if (rawToken && typeof rawToken === 'string') {
      const tokenHash = sha256Hex(rawToken);
      const nowMs = getEffectiveNowMs(req);
      const nowIso = new Date(nowMs).toISOString();
      const cfg = getAuthSecurityConfig();

      const sessionRow = db
        .prepare(
          `
          SELECT
            s.token_hash, s.csrf_token, s.last_active_at, s.expires_at, s.revoked_at,
            u.id as user_id, u.email, u.phone, u.full_name, u.role, u.status, u.must_change_password, u.mfa_enabled
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?
        `
        )
        .get(tokenHash) as
        | {
            token_hash: string;
            csrf_token: string;
            last_active_at: string;
            expires_at: string;
            revoked_at: string | null;
            user_id: string;
            email: string;
            phone: string;
            full_name: string;
            role: UserRole;
            status: string;
            must_change_password: number;
            mfa_enabled: number;
          }
        | undefined;

      if (
        sessionRow &&
        !sessionRow.revoked_at &&
        sessionRow.expires_at > nowIso &&
        sessionRow.status === 'active'
      ) {
        const lastActiveMs = sessionRow.last_active_at ? Date.parse(sessionRow.last_active_at) : nowMs;
        if (!Number.isNaN(lastActiveMs) && nowMs - lastActiveMs > cfg.sessionIdleTimeoutMs) {
          // Revoke session due to inactivity timeout
          db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso, tokenHash);
        } else {
          db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(nowIso, tokenHash);
          req.user = {
            id: sessionRow.user_id,
            email: sessionRow.email,
            phone: sessionRow.phone,
            fullName: sessionRow.full_name,
            role: sessionRow.role,
            status: sessionRow.status,
            mustChangePassword: Boolean(sessionRow.must_change_password),
            mfaEnabled: Boolean(sessionRow.mfa_enabled),
          };
          req.sessionTokenHash = sessionRow.token_hash;
          req.csrfToken = sessionRow.csrf_token;
        }
      }
    }

    next();
  });

  // Public healthcheck endpoint for uptime monitoring and deployment probes
  router.get('/health', (_req: Request, res: Response) => {
    try {
      const ping = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
      const recon = reconcileFinance(db);
      const storage = getStorageStatus();
      res.status(ping?.ok === 1 && recon.isHealthy ? 200 : 503).json({
        status: ping?.ok === 1 && recon.isHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        dbConnected: ping?.ok === 1,
        reconciliationHealthy: recon.isHealthy,
        storageMode: storage.mode,
      });
    } catch {
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        dbConnected: false,
      });
    }
  });

  function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'Требуется вход в систему.' });
      return;
    }
    // Enforce CSRF token on all state-changing requests
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.csrfToken) {
      const headerCsrf = req.headers['x-csrf-token'];
      const providedCsrf = Array.isArray(headerCsrf) ? headerCsrf[0] : headerCsrf || '';
      if (!providedCsrf || !safeCompareStrings(providedCsrf, req.csrfToken)) {
        recordAudit(db, {
          actorUserId: req.user.id,
          actorEmail: req.user.phone || req.user.email,
          action: 'CSRF_VALIDATION_FAILED',
          entityType: 'security',
          entityId: req.path,
          summary: `Отклонён запрос ${req.method} ${req.path} из-за отсутствующего или неверного X-CSRF-Token.`,
        });
        res.status(403).json({ error: 'Ошибка проверки CSRF-токена безопасности. Обновите страницу.' });
        return;
      }
    }
    next();
  }

  function requireRoles(allowedRoles: UserRole[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user) {
        res.status(401).json({ error: 'Требуется авторизация.' });
        return;
      }
      if (!allowedRoles.includes(req.user.role)) {
        recordAudit(db, {
          actorUserId: req.user.id,
          actorEmail: req.user.phone || req.user.email,
          action: 'AUTHZ_DENIED',
          entityType: 'security',
          entityId: req.path,
          summary: `Отказ в доступе пользователю ${req.user.phone} (роль: «${req.user.role}») к ресурсу ${req.method} ${req.path}.`,
        });
        res.status(403).json({
          error: 'Недостаточно прав для выполнения данного действия.',
        });
        return;
      }
      next();
    };
  }

  // ==================== 1. AUTHENTICATION (PHONE + PASSWORD ONLY) ====================

  router.get('/auth/session', (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      res.json({ authenticated: false, user: null, csrfToken: null, sessionToken: null });
      return;
    }
    res.json({
      authenticated: true,
      user: req.user,
      csrfToken: req.csrfToken,
      sessionToken: null,
    });
  });

  // Explicitly disable all legacy self-registration & quick-switch endpoints
  const disabledRegistrationHandler = (req: Request, res: Response) => {
    recordAudit(db, {
      actorUserId: null,
      actorEmail: getSafeClientIp(req),
      action: 'PUBLIC_REGISTRATION_BLOCKED',
      entityType: 'security',
      entityId: req.path,
      summary: `Отклонён запрос к отключённому публичному маршруту регистрации ${req.method} ${req.path}.`,
    });
    res.status(404).json({
      error: 'Самостоятельная регистрация отключена. Учётные записи создаются только администратором.',
    });
  };
  router.all('/auth/register', disabledRegistrationHandler);
  router.all('/auth/register-request', disabledRegistrationHandler);
  router.all('/auth/verify-email', disabledRegistrationHandler);
  router.all('/auth/quick-switch', disabledRegistrationHandler);

  // Phone + Password Login with multi-layered atomic brute-force & enumeration protection
  router.post('/auth/login', (req: Request, res: Response) => {
    const cfg = getAuthSecurityConfig();
    const clientIp = getSafeClientIp(req);
    const nowMs = getEffectiveNowMs(req);
    const nowIso = new Date(nowMs).toISOString();

    const { phone, password, totpCode } = req.body as {
      phone?: unknown;
      password?: unknown;
      totpCode?: unknown;
    };

    if (typeof phone !== 'string' || typeof password !== 'string' || !phone.trim() || !password) {
      res.status(400).json({ error: 'Укажите номер телефона и пароль.' });
      return;
    }

    const normalizedPhone = normalizeRussianPhone(phone);
    const phoneBucketKey = normalizedPhone
      ? `acct:${normalizedPhone}`
      : `acct_invalid:${sha256Hex(phone.trim()).slice(0, 24)}`;
    const ipBucketKey = `ip:${clientIp}`;
    const globalBucketKey = 'global:auth_login';

    // Step 1: Atomic pre-check of Global, IP, and Normalized-Phone lockouts
    let preCheckBlocked = false;
    let userRow:
      | {
          id: string;
          email: string;
          phone: string;
          full_name: string;
          password_hash: string;
          role: UserRole;
          status: string;
          must_change_password: number;
          mfa_enabled: number;
          mfa_secret: string | null;
          failed_login_attempts: number;
          locked_until: string | null;
        }
      | undefined;

    withTransaction(db, () => {
      const globalStatus = incrementRateLimitBucket(
        db,
        globalBucketKey,
        cfg.globalMaxPerMin,
        60 * 1000,
        60 * 1000,
        nowMs
      );
      const ipStatus = checkRateLimitBucket(db, ipBucketKey, nowMs);
      const phoneStatus = checkRateLimitBucket(db, phoneBucketKey, nowMs);

      if (normalizedPhone) {
        userRow = db
          .prepare('SELECT * FROM users WHERE phone = ?')
          .get(normalizedPhone) as typeof userRow;
      }

      const userLocked = Boolean(
        userRow && userRow.locked_until && userRow.locked_until > nowIso
      );

      if (globalStatus.lockedNow || ipStatus.locked || phoneStatus.locked || userLocked) {
        preCheckBlocked = true;
        recordAudit(db, {
          actorUserId: userRow ? userRow.id : null,
          actorEmail: normalizedPhone || clientIp,
          action: 'AUTH_RATE_LIMIT_TRIGGERED',
          entityType: 'security',
          entityId: normalizedPhone || clientIp,
          summary: `Временно заблокирована попытка входа (сработала защита от перебора: IP=${clientIp}).`,
        });
      }
    });

    if (preCheckBlocked) {
      res.status(429).json({
        error: 'Слишком много попыток входа. Пожалуйста, повторите попытку позже.',
      });
      return;
    }

    // Step 2: Constant-time password verification (always runs full KDF work even if userRow is undefined)
    const passwordMatches = verifyPasswordConstantTime(password, userRow?.password_hash);
    const isAccountActive = Boolean(userRow && userRow.status === 'active');

    if (!userRow || !passwordMatches || !isAccountActive) {
      withTransaction(db, () => {
        const ipRes = incrementRateLimitBucket(
          db,
          ipBucketKey,
          cfg.ipMaxAttempts,
          cfg.ipWindowMs,
          cfg.ipLockoutMs,
          nowMs
        );
        const acctRes = incrementRateLimitBucket(
          db,
          phoneBucketKey,
          cfg.accountMaxAttempts,
          cfg.accountWindowMs,
          cfg.accountLockoutMs,
          nowMs
        );

        if (userRow) {
          db.prepare(
            'UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?'
          ).run(acctRes.failures, acctRes.lockedUntil, userRow.id);
        }

        const reasonTag = !userRow
          ? 'unknown_phone'
          : !passwordMatches
          ? 'invalid_password'
          : `inactive_status_${userRow.status}`;

        recordAudit(db, {
          actorUserId: userRow ? userRow.id : null,
          actorEmail: normalizedPhone || 'invalid_format',
          action: acctRes.lockedNow || ipRes.lockedNow ? 'AUTH_BRUTEFORCE_LOCKOUT' : 'AUTH_LOGIN_FAILED',
          entityType: 'security',
          entityId: userRow ? userRow.id : phoneBucketKey,
          summary: `Неудачная попытка входа (${reasonTag}, IP=${clientIp}, попытка #${acctRes.failures}).`,
        });
      });

      // Uniform error message: never reveal whether the phone exists or if the account is blocked
      res.status(401).json({ error: 'Неверный номер телефона или пароль' });
      return;
    }

    // Step 3: Optional TOTP MFA check for administrator if enabled
    if (userRow.mfa_enabled && userRow.mfa_secret) {
      if (typeof totpCode !== 'string' || !totpCode.trim()) {
        res.status(200).json({
          mfaRequired: true,
          message: 'Введите 6-значный код двухфакторной аутентификации (TOTP).',
        });
        return;
      }
      if (!verifyTotpCode(userRow.mfa_secret, totpCode)) {
        withTransaction(db, () => {
          incrementRateLimitBucket(
            db,
            phoneBucketKey,
            cfg.accountMaxAttempts,
            cfg.accountWindowMs,
            cfg.accountLockoutMs,
            nowMs
          );
          recordAudit(db, {
            actorUserId: userRow!.id,
            actorEmail: userRow!.phone,
            action: 'AUTH_MFA_FAILED',
            entityType: 'security',
            entityId: userRow!.id,
            summary: `Неверный код TOTP MFA при входе (IP=${clientIp}).`,
          });
        });
        res.status(401).json({ error: 'Неверный номер телефона или пароль' });
        return;
      }
    }

    // Step 4: Successful authentication -> clear account failure counter & issue session
    let sessionResult = { rawToken: '', csrfToken: '' };
    withTransaction(db, () => {
      resetRateLimitBucket(db, phoneBucketKey);
      db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(
        userRow!.id
      );
      sessionResult = createSessionForUser(req, res, userRow!.id, nowMs);
      recordAudit(db, {
        actorUserId: userRow!.id,
        actorEmail: userRow!.phone,
        action: 'AUTH_LOGIN_SUCCESS',
        entityType: 'user',
        entityId: userRow!.id,
        summary: `Успешный вход пользователя ${userRow!.phone} (роль: ${userRow!.role}, IP=${clientIp}).`,
      });
    });

    res.json({
      authenticated: true,
      sessionToken: sessionResult.rawToken,
      csrfToken: sessionResult.csrfToken,
      user: {
        id: userRow.id,
        email: userRow.email,
        phone: userRow.phone,
        fullName: userRow.full_name,
        role: userRow.role,
        status: userRow.status,
        mustChangePassword: Boolean(userRow.must_change_password),
        mfaEnabled: Boolean(userRow.mfa_enabled),
      },
    });
  });

  // Self password change (including mandatory password change on first login)
  router.post('/auth/change-password', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'Укажите текущий и новый пароль.' });
      return;
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      res.status(400).json({ error: 'Новый пароль должен содержать от 8 до 128 символов.' });
      return;
    }

    if (currentPassword === newPassword) {
      res.status(400).json({ error: 'Новый пароль должен отличаться от текущего.' });
      return;
    }

    const userRow = db
      .prepare('SELECT id, phone, password_hash FROM users WHERE id = ?')
      .get(req.user!.id) as { id: string; phone: string; password_hash: string } | undefined;

    if (!userRow || !verifyPassword(currentPassword, userRow.password_hash)) {
      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.phone,
        action: 'USER_PASSWORD_CHANGE_FAILED',
        entityType: 'user',
        entityId: req.user!.id,
        summary: 'Неудачная попытка смены пароля: неверный текущий пароль.',
      });
      res.status(400).json({ error: 'Неверный текущий пароль.' });
      return;
    }

    const nowIso = new Date(getEffectiveNowMs(req)).toISOString();
    const newHash = hashPassword(newPassword);

    withTransaction(db, () => {
      db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?'
      ).run(newHash, nowIso, userRow.id);

      // Revoke all other active sessions of this user
      if (req.sessionTokenHash) {
        db.prepare(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL'
        ).run(nowIso, userRow.id, req.sessionTokenHash);
      }

      recordAudit(db, {
        actorUserId: userRow.id,
        actorEmail: userRow.phone,
        action: 'USER_PASSWORD_CHANGED',
        entityType: 'user',
        entityId: userRow.id,
        summary: `Пользователь ${userRow.phone} сменил пароль (предыдущие сессии отозваны).`,
      });
    });

    res.json({ ok: true, mustChangePassword: false });
  });

  router.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    if (req.sessionTokenHash) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(
        new Date().toISOString(),
        req.sessionTokenHash
      );
    }
    clearSessionCookie(res);
    recordAudit(db, {
      actorUserId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'AUTH_LOGOUT',
      entityType: 'user',
      entityId: req.user!.id,
      summary: `Пользователь ${req.user!.email} завершил сессию.`,
    });
    res.json({ ok: true });
  });

  // Owner TOTP MFA Setup & Verification
  router.post(
    '/auth/mfa/setup',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const secret = generateTotpSecret(20);
      db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, req.user!.id);
      const currentSampleCode = computeTotpCode(secret);
      const otpauthUrl = `otpauth://totp/RassrochkaPro:${encodeURIComponent(req.user!.email)}?secret=${secret}&issuer=RassrochkaPro`;
      res.json({
        secret,
        otpauthUrl,
        currentSampleCode,
      });
    }
  );

  router.post(
    '/auth/mfa/enable',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const { code } = req.body as { code?: string };
      const row = db
        .prepare('SELECT mfa_secret FROM users WHERE id = ?')
        .get(req.user!.id) as { mfa_secret: string | null } | undefined;

      if (!row || !row.mfa_secret) {
        res.status(400).json({ error: 'Сначала сгенерируйте секретный ключ TOTP.' });
        return;
      }
      if (!code || !verifyTotpCode(row.mfa_secret, code)) {
        res.status(400).json({ error: 'Неверный проверочный код TOTP. Проверьте время на устройстве.' });
        return;
      }

      db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(req.user!.id);
      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'OWNER_MFA_ENABLED',
        entityType: 'user',
        entityId: req.user!.id,
        summary: 'Владелец включил двухфакторную аутентификацию (TOTP MFA).',
      });
      res.json({ mfaEnabled: true });
    }
  );

  router.post(
    '/auth/mfa/disable',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?').run(req.user!.id);
      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'OWNER_MFA_DISABLED',
        entityType: 'user',
        entityId: req.user!.id,
        summary: 'Владелец отключил TOTP MFA.',
      });
      res.json({ mfaEnabled: false });
    }
  );

  // ==================== 2. BOOTSTRAP / FULL STATE FOR DASHBOARD ====================

  router.get('/state', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const todayIso = new Date().toISOString().slice(0, 10);

    // Installment plans
    const plansRaw = db
      .prepare('SELECT * FROM installment_plans ORDER BY term_months ASC')
      .all() as Array<Record<string, unknown>>;
    const plans = plansRaw.map((p) => ({
      id: String(p.id),
      name: String(p.name),
      termMonths: Number(p.term_months),
      markupPercent: Number(p.markup_percent),
      downPaymentPercent: Number(p.down_payment_percent),
      downPaymentRequired: Boolean(p.down_payment_required),
      roundingRule: String(p.rounding_rule) as RoundingRule,
      earlyPayoffDiscountPercent: Number(p.early_payoff_discount_percent),
      isActive: Boolean(p.is_active),
      version: Number(p.version),
      updatedAt: String(p.updated_at),
    }));

    // Settings history
    const settingsHistoryRaw = db
      .prepare(
        `
        SELECT sh.*, COALESCE(u.email, 'system') as changed_by_email
        FROM settings_history sh
        LEFT JOIN users u ON u.id = sh.changed_by
        ORDER BY sh.created_at DESC LIMIT 50
      `
      )
      .all() as Array<Record<string, unknown>>;
    const settingsHistory = settingsHistoryRaw.map((s) => ({
      id: String(s.id),
      settingType: String(s.setting_type),
      entityId: String(s.entity_id),
      oldValueJson: String(s.old_value_json),
      newValueJson: String(s.new_value_json),
      reason: String(s.reason),
      changedByEmail: String(s.changed_by_email),
      createdAt: String(s.created_at),
    }));

    // Schedule items & versions
    const allScheduleItemsRaw = db
      .prepare('SELECT * FROM schedule_items ORDER BY schedule_version DESC, installment_number ASC')
      .all() as Array<Record<string, unknown>>;

    const allScheduleVersionsRaw = db
      .prepare(
        `
        SELECT sv.*, COALESCE(u.email, 'system') as created_by_email
        FROM schedule_versions sv
        LEFT JOIN users u ON u.id = sv.created_by
        ORDER BY sv.version DESC
      `
      )
      .all() as Array<Record<string, unknown>>;

    // Contracts
    const contractsRaw = db
      .prepare(
        `
        SELECT c.*, cl.full_name as client_name, cl.phone as client_phone
        FROM contracts c
        JOIN clients cl ON cl.id = c.client_id
        ORDER BY c.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;

    const contracts = contractsRaw.map((c) => {
      const cId = String(c.id);
      const currentVer = Number(c.current_schedule_version);
      const contractItems = allScheduleItemsRaw
        .filter((i) => String(i.contract_id) === cId)
        .map((i) => {
          const planned = Number(i.planned_kopecks);
          const paid = Number(i.paid_kopecks);
          const remaining = Math.max(0, planned - paid);
          const dueDate = String(i.due_date);
          const daysOverdue = remaining > 0 ? calculateDaysOverdue(dueDate, todayIso) : 0;
          let status = String(i.status);
          if (Number(i.schedule_version) === currentVer && remaining > 0 && dueDate < todayIso) {
            status = 'overdue';
          } else if (remaining === 0 && status !== 'superseded' && status !== 'waived') {
            status = 'paid';
          } else if (paid > 0 && remaining > 0 && status !== 'overdue') {
            status = 'partial';
          }
          return {
            id: String(i.id),
            contractId: cId,
            scheduleVersion: Number(i.schedule_version),
            installmentNumber: Number(i.installment_number),
            dueDate,
            originalDueDate: String(i.original_due_date),
            plannedKopecks: planned,
            paidKopecks: paid,
            remainingKopecks: remaining,
            status: status as any,
            daysOverdue,
            promisedDate: i.promised_date ? String(i.promised_date) : null,
            postponeReason: String(i.postpone_reason || ''),
          };
        });

      const activeSchedule = contractItems.filter((i) => i.scheduleVersion === currentVer);
      const totalPaidOnScheduleKopecks = activeSchedule.reduce((acc, i) => acc + i.paidKopecks, 0);
      const remainingDebtKopecks =
        c.status === 'completed' || c.status === 'returned' || c.status === 'cancelled'
          ? 0
          : activeSchedule.reduce((acc, i) => acc + i.remainingKopecks, 0);
      const overdueKopecks =
        c.status === 'active' || c.status === 'restructured'
          ? activeSchedule
              .filter((i) => i.daysOverdue > 0)
              .reduce((acc, i) => acc + i.remainingKopecks, 0)
          : 0;

      const scheduleHistory = allScheduleVersionsRaw
        .filter((sv) => String(sv.contract_id) === cId)
        .map((sv) => ({
          id: String(sv.id),
          contractId: cId,
          version: Number(sv.version),
          changeReason: String(sv.change_reason),
          createdByEmail: String(sv.created_by_email),
          createdAt: String(sv.created_at),
          items: contractItems.filter((i) => i.scheduleVersion === Number(sv.version)),
        }));

      const totalCost = Number(c.total_cost_kopecks);
      const salePrice = Number(c.sale_price_kopecks);
      const downPayment = Number(c.down_payment_kopecks);

      return {
        id: cId,
        contractNumber: String(c.contract_number),
        clientId: String(c.client_id),
        clientName: String(c.client_name),
        clientPhone: String(c.client_phone),
        purchaseId: c.purchase_id ? String(c.purchase_id) : null,
        planId: c.plan_id ? String(c.plan_id) : null,
        planVersion: Number(c.plan_version),
        itemTitle: String(c.item_title),
        purchaseCostKopecks: Number(c.purchase_cost_kopecks),
        extraCostKopecks: Number(c.extra_cost_kopecks),
        totalCostKopecks: totalCost,
        markupPercent: Number(c.markup_percent),
        markupKopecks: salePrice - totalCost,
        salePriceKopecks: salePrice,
        downPaymentPercent: Number(c.down_payment_percent),
        downPaymentKopecks: downPayment,
        financedPrincipalKopecks: Number(c.financed_principal_kopecks),
        termMonths: Number(c.term_months),
        roundingRule: String(c.rounding_rule) as RoundingRule,
        scheduleType: String(c.schedule_type) as ScheduleType,
        startDate: String(c.start_date),
        currentScheduleVersion: currentVer,
        status: String(c.status) as any,
        closingDiscountKopecks: Number(c.closing_discount_kopecks || 0),
        closedAt: c.closed_at ? String(c.closed_at) : null,
        notes: String(c.notes || ''),
        createdAt: String(c.created_at),
        totalPaidOnScheduleKopecks,
        totalCollectedKopecks: downPayment + totalPaidOnScheduleKopecks,
        remainingDebtKopecks,
        overdueKopecks,
        schedule: activeSchedule,
        scheduleHistory,
      };
    });

    // Clients with aggregated debt
    const clientsRaw = db
      .prepare('SELECT * FROM clients ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    const clients = clientsRaw.map((cl) => {
      const clientId = String(cl.id);
      const clientContracts = contracts.filter(
        (c) => c.clientId === clientId && (c.status === 'active' || c.status === 'restructured')
      );
      return {
        id: clientId,
        fullName: String(cl.full_name),
        phone: String(cl.phone),
        secondaryPhone: String(cl.secondary_phone || ''),
        documentRef: String(cl.document_ref || ''),
        address: String(cl.address || ''),
        notes: String(cl.notes || ''),
        status: String(cl.status) as 'active' | 'archived',
        createdAt: String(cl.created_at),
        activeContractsCount: clientContracts.length,
        totalDebtKopecks: clientContracts.reduce((sum, c) => sum + c.remainingDebtKopecks, 0),
        overdueDebtKopecks: clientContracts.reduce((sum, c) => sum + c.overdueKopecks, 0),
      };
    });

    // Purchases
    const purchasesRaw = db
      .prepare(
        `
        SELECT p.*, s.name as supplier_name, cl.full_name as client_name,
               c.id as contract_id, c.contract_number
        FROM purchases p
        JOIN suppliers s ON s.id = p.supplier_id
        LEFT JOIN clients cl ON cl.id = p.client_id
        LEFT JOIN contracts c ON c.purchase_id = p.id
        ORDER BY p.purchase_date DESC, p.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;
    const purchases = purchasesRaw.map((p) => ({
      id: String(p.id),
      supplierId: String(p.supplier_id),
      supplierName: String(p.supplier_name),
      clientId: p.client_id ? String(p.client_id) : null,
      clientName: p.client_name ? String(p.client_name) : null,
      itemName: String(p.item_name),
      itemCategory: String(p.item_category),
      quantity: Number(p.quantity),
      purchasePriceKopecks: Number(p.purchase_price_kopecks),
      deliveryCostKopecks: Number(p.delivery_cost_kopecks),
      otherCostKopecks: Number(p.other_cost_kopecks),
      totalCostKopecks: Number(p.total_cost_kopecks),
      paidToSupplierKopecks: Number(p.paid_to_supplier_kopecks),
      supplierDebtKopecks: Number(p.supplier_debt_kopecks),
      handoverStatus: String(p.handover_status) as any,
      purchaseDate: String(p.purchase_date),
      notes: String(p.notes || ''),
      contractId: p.contract_id ? String(p.contract_id) : null,
      contractNumber: p.contract_number ? String(p.contract_number) : null,
      createdAt: String(p.created_at),
    }));

    // Suppliers
    const suppliersRaw = db
      .prepare('SELECT * FROM suppliers ORDER BY name ASC')
      .all() as Array<Record<string, unknown>>;
    const suppliers = suppliersRaw.map((s) => {
      const supId = String(s.id);
      const supPurchases = purchases.filter((p) => p.supplierId === supId);
      return {
        id: supId,
        name: String(s.name),
        category: String(s.category),
        contactInfo: String(s.contact_info || ''),
        notes: String(s.notes || ''),
        isActive: Boolean(s.is_active),
        createdAt: String(s.created_at),
        totalPurchasedKopecks: supPurchases.reduce((sum, p) => sum + p.purchasePriceKopecks, 0),
        totalPaidKopecks: supPurchases.reduce((sum, p) => sum + p.paidToSupplierKopecks, 0),
        totalDebtKopecks: supPurchases.reduce((sum, p) => sum + p.supplierDebtKopecks, 0),
        purchasesCount: supPurchases.length,
      };
    });

    // Allocations & Payments
    const allocationsRaw = db
      .prepare(
        `
        SELECT pa.*, c.contract_number, si.installment_number, si.due_date
        FROM payment_allocations pa
        JOIN contracts c ON c.id = pa.contract_id
        JOIN schedule_items si ON si.id = pa.schedule_item_id
        ORDER BY pa.created_at ASC
      `
      )
      .all() as Array<Record<string, unknown>>;

    const paymentsRaw = db
      .prepare(
        `
        SELECT p.*, cl.full_name as client_name, c.contract_number,
               fa.name as account_name, COALESCE(u.email, 'system') as created_by_email
        FROM payments p
        JOIN clients cl ON cl.id = p.client_id
        LEFT JOIN contracts c ON c.id = p.contract_id
        JOIN financial_accounts fa ON fa.id = p.account_id
        LEFT JOIN users u ON u.id = p.created_by
        ORDER BY p.event_date DESC, p.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;

    const payments = paymentsRaw.map((p) => {
      const payId = String(p.id);
      const allocs = allocationsRaw
        .filter((a) => String(a.payment_id) === payId)
        .map((a) => ({
          id: String(a.id),
          paymentId: payId,
          contractId: String(a.contract_id),
          contractNumber: String(a.contract_number),
          scheduleItemId: String(a.schedule_item_id),
          installmentNumber: Number(a.installment_number),
          dueDate: String(a.due_date),
          amountKopecks: Number(a.amount_kopecks),
          status: String(a.status) as 'active' | 'reversed',
          createdAt: String(a.created_at),
        }));
      return {
        id: payId,
        idempotencyKey: String(p.idempotency_key),
        clientId: String(p.client_id),
        clientName: String(p.client_name),
        contractId: p.contract_id ? String(p.contract_id) : null,
        contractNumber: p.contract_number ? String(p.contract_number) : null,
        accountId: String(p.account_id),
        accountName: String(p.account_name),
        paymentMethod: String(p.payment_method) as any,
        amountKopecks: Number(p.amount_kopecks),
        allocatedKopecks: Number(p.allocated_kopecks),
        unallocatedKopecks: Number(p.unallocated_kopecks),
        isDownPayment: Boolean(p.is_down_payment),
        status: String(p.status) as 'confirmed' | 'reversed',
        reversalReason: String(p.reversal_reason || ''),
        eventDate: String(p.event_date),
        notes: String(p.notes || ''),
        createdByEmail: String(p.created_by_email),
        createdAt: String(p.created_at),
        allocations: allocs,
      };
    });

    // Overdues & Contacts
    const overdueContactsRaw = db
      .prepare(
        `
        SELECT oc.*, COALESCE(u.email, 'system') as created_by_email
        FROM overdue_contacts oc
        LEFT JOIN users u ON u.id = oc.created_by
        ORDER BY oc.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;

    const overdues = [];
    for (const c of contracts) {
      if (c.status !== 'active' && c.status !== 'restructured') continue;
      for (const item of c.schedule) {
        if (item.daysOverdue > 0 && item.remainingKopecks > 0) {
          const itemContacts = overdueContactsRaw
            .filter((oc) => String(oc.schedule_item_id) === item.id)
            .map((oc) => ({
              id: String(oc.id),
              contactChannel: String(oc.contact_channel) as any,
              summary: String(oc.summary),
              promisedDate: oc.promised_date ? String(oc.promised_date) : null,
              createdByEmail: String(oc.created_by_email),
              createdAt: String(oc.created_at),
            }));
          overdues.push({
            scheduleItemId: item.id,
            contractId: c.id,
            contractNumber: c.contractNumber,
            clientId: c.clientId,
            clientName: c.clientName,
            clientPhone: c.clientPhone,
            itemTitle: c.itemTitle,
            installmentNumber: item.installmentNumber,
            dueDate: item.dueDate,
            plannedKopecks: item.plannedKopecks,
            paidKopecks: item.paidKopecks,
            overdueKopecks: item.remainingKopecks,
            daysOverdue: item.daysOverdue,
            promisedDate: item.promisedDate,
            postponeReason: item.postponeReason,
            contacts: itemContacts,
          });
        }
      }
    }

    // Accounts & Ledger
    const accountsRaw = db
      .prepare('SELECT * FROM financial_accounts ORDER BY account_type ASC')
      .all() as Array<Record<string, unknown>>;
    const accounts = accountsRaw.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      accountType: String(a.account_type) as 'cash' | 'bank',
      balanceKopecks: Number(a.balance_kopecks),
      isActive: Boolean(a.is_active),
    }));

    const ledgerRaw = db
      .prepare(
        `
        SELECT l.*, fa.name as account_name, COALESCE(u.email, 'system') as created_by_email
        FROM ledger_entries l
        JOIN financial_accounts fa ON fa.id = l.account_id
        LEFT JOIN users u ON u.id = l.created_by
        ORDER BY l.event_date DESC, l.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;
    const ledger = ledgerRaw.map((l) => ({
      id: String(l.id),
      idempotencyKey: String(l.idempotency_key),
      accountId: String(l.account_id),
      accountName: String(l.account_name),
      relatedAccountId: l.related_account_id ? String(l.related_account_id) : null,
      entryType: String(l.entry_type) as any,
      category: String(l.category || ''),
      direction: String(l.direction) as 'in' | 'out',
      amountKopecks: Number(l.amount_kopecks),
      referenceType: String(l.reference_type || ''),
      referenceId: String(l.reference_id || ''),
      reversalOfId: l.reversal_of_id ? String(l.reversal_of_id) : null,
      reversalReason: String(l.reversal_reason || ''),
      description: String(l.description),
      eventDate: String(l.event_date),
      status: String(l.status) as 'confirmed' | 'reversed',
      createdByEmail: String(l.created_by_email),
      createdAt: String(l.created_at),
    }));

    // Documents
    const docsRaw = db
      .prepare(
        `
        SELECT d.id, d.entity_type, d.entity_id, d.doc_category, d.title,
               d.original_filename, d.mime_type, d.size_bytes, d.sha256_hash, d.created_at,
               COALESCE(u.email, 'system') as created_by_email
        FROM documents d
        LEFT JOIN users u ON u.id = d.created_by
        ORDER BY d.created_at DESC
      `
      )
      .all() as Array<Record<string, unknown>>;
    const documents = docsRaw.map((d) => ({
      id: String(d.id),
      entityType: String(d.entity_type) as any,
      entityId: String(d.entity_id),
      docCategory: String(d.doc_category) as any,
      title: String(d.title),
      originalFilename: String(d.original_filename),
      mimeType: String(d.mime_type),
      sizeBytes: Number(d.size_bytes),
      sha256Hash: String(d.sha256_hash),
      createdByEmail: String(d.created_by_email),
      createdAt: String(d.created_at),
    }));

    // Owner-only data: Users, Backups, Audit logs
    let usersList: unknown[] = [];
    let backupsList: unknown[] = [];
    let auditLogs: unknown[] = [];

    if (req.user!.role === 'owner') {
      const usersRaw = db
        .prepare(
          'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at FROM users ORDER BY created_at DESC'
        )
        .all() as Array<Record<string, unknown>>;
      usersList = usersRaw.map((u) => ({
        id: String(u.id),
        email: String(u.email),
        fullName: String(u.full_name),
        phone: String(u.phone || ''),
        role: String(u.role),
        status: String(u.status) === 'active' ? 'active' : 'blocked',
        mustChangePassword: Boolean(u.must_change_password),
        passwordChangedAt: u.password_changed_at ? String(u.password_changed_at) : null,
        mfaEnabled: Boolean(u.mfa_enabled),
        approvedBy: u.approved_by ? String(u.approved_by) : null,
        approvedAt: u.approved_at ? String(u.approved_at) : null,
        createdAt: String(u.created_at),
      }));

      const backupsRaw = db
        .prepare(
          `
          SELECT b.*, COALESCE(u.email, 'system') as created_by_email
          FROM backups b
          LEFT JOIN users u ON u.id = b.created_by
          ORDER BY b.created_at DESC
        `
        )
        .all() as Array<Record<string, unknown>>;
      backupsList = backupsRaw.map((b) => ({
        id: String(b.id),
        filename: String(b.filename),
        sizeBytes: Number(b.size_bytes),
        sha256Hash: String(b.sha256_hash),
        encryptedAlg: String(b.encrypted_alg),
        contractsCount: Number(b.contracts_count),
        ledgerNetKopecks: Number(b.ledger_net_kopecks),
        verifiedRestoreAt: b.verified_restore_at ? String(b.verified_restore_at) : null,
        status: String(b.status),
        createdByEmail: String(b.created_by_email),
        createdAt: String(b.created_at),
      }));

      const auditRaw = db
        .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100')
        .all() as Array<Record<string, unknown>>;
      auditLogs = auditRaw.map((a) => ({
        id: String(a.id),
        actorEmail: String(a.actor_email),
        action: String(a.action),
        entityType: String(a.entity_type),
        entityId: String(a.entity_id),
        summary: String(a.summary),
        metadataJson: String(a.metadata_json),
        createdAt: String(a.created_at),
      }));
    }

    const reconciliation = reconcileFinance(db);

    res.json({
      plans,
      settingsHistory,
      clients,
      suppliers,
      purchases,
      contracts,
      payments,
      overdues,
      accounts,
      ledger,
      documents,
      users: usersList,
      backups: backupsList,
      auditLogs,
      reconciliation,
    });
  });

  // ==================== 3. INSTALLMENT SETTINGS (VERSIONED) ====================

  router.post(
    '/settings/plans',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const {
        name,
        termMonths,
        markupPercent,
        downPaymentPercent,
        downPaymentRequired,
        roundingRule,
        earlyPayoffDiscountPercent,
        reason,
      } = req.body as {
        name?: string;
        termMonths?: number;
        markupPercent?: number;
        downPaymentPercent?: number;
        downPaymentRequired?: boolean;
        roundingRule?: RoundingRule;
        earlyPayoffDiscountPercent?: number;
        reason?: string;
      };

      if (!name || !termMonths || termMonths < 1 || termMonths > 120) {
        res.status(400).json({ error: 'Укажите название тарифа и срок от 1 до 120 месяцев.' });
        return;
      }
      if (typeof markupPercent !== 'number' || markupPercent < 0 || markupPercent > 500) {
        res.status(400).json({ error: 'Процент наценки должен быть от 0% до 500%.' });
        return;
      }
      if (typeof downPaymentPercent !== 'number' || downPaymentPercent < 0 || downPaymentPercent >= 100) {
        res.status(400).json({ error: 'Стандартный процент первоначального взноса должен быть от 0% до 99%.' });
        return;
      }

      const id = `plan_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const rule: RoundingRule =
        roundingRule && ['kopeck', 'ruble', 'ten_rubles'].includes(roundingRule)
          ? roundingRule
          : 'kopeck';
      const earlyDiscount = Math.max(0, Math.min(100, Number(earlyPayoffDiscountPercent || 0)));

      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO installment_plans (
            id, name, term_months, markup_percent, down_payment_percent,
            down_payment_required, rounding_rule, early_payoff_discount_percent,
            is_active, version, updated_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
        `).run(
          id,
          name.trim(),
          Math.trunc(termMonths),
          markupPercent,
          downPaymentPercent,
          downPaymentRequired !== false ? 1 : 0,
          rule,
          earlyDiscount,
          req.user!.id,
          now,
          now
        );

        db.prepare(`
          INSERT INTO settings_history (id, setting_type, entity_id, old_value_json, new_value_json, reason, changed_by, created_at)
          VALUES (?, 'installment_plan_created', ?, '{}', ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          id,
          JSON.stringify({
            name: name.trim(),
            termMonths,
            markupPercent,
            downPaymentPercent,
            roundingRule: rule,
          }),
          (reason || 'Создание нового тарифа рассрочки').trim(),
          req.user!.id,
          now
        );

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.email,
          action: 'INSTALLMENT_PLAN_CREATED',
          entityType: 'installment_plan',
          entityId: id,
          summary: `Создан тариф рассрочки «${name.trim()}» (${termMonths} мес., наценка ${markupPercent}%, взнос ${downPaymentPercent}%).`,
        });
      });

      res.status(201).json({ id });
    }
  );

  router.put(
    '/settings/plans/:id',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const planId = req.params.id;
      const existing = db.prepare('SELECT * FROM installment_plans WHERE id = ?').get(planId) as
        | Record<string, unknown>
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Тариф рассрочки не найден.' });
        return;
      }

      const {
        name,
        termMonths,
        markupPercent,
        downPaymentPercent,
        downPaymentRequired,
        roundingRule,
        earlyPayoffDiscountPercent,
        isActive,
        reason,
      } = req.body as {
        name?: string;
        termMonths?: number;
        markupPercent?: number;
        downPaymentPercent?: number;
        downPaymentRequired?: boolean;
        roundingRule?: RoundingRule;
        earlyPayoffDiscountPercent?: number;
        isActive?: boolean;
        reason?: string;
      };

      const nextName = name ? name.trim() : String(existing.name);
      const nextTerm = typeof termMonths === 'number' ? Math.trunc(termMonths) : Number(existing.term_months);
      const nextMarkup = typeof markupPercent === 'number' ? markupPercent : Number(existing.markup_percent);
      const nextDp =
        typeof downPaymentPercent === 'number' ? downPaymentPercent : Number(existing.down_payment_percent);
      const nextDpReq =
        typeof downPaymentRequired === 'boolean'
          ? downPaymentRequired
          : Boolean(existing.down_payment_required);
      const nextRule: RoundingRule =
        roundingRule && ['kopeck', 'ruble', 'ten_rubles'].includes(roundingRule)
          ? roundingRule
          : (String(existing.rounding_rule) as RoundingRule);
      const nextEarlyDiscount =
        typeof earlyPayoffDiscountPercent === 'number'
          ? Math.max(0, Math.min(100, earlyPayoffDiscountPercent))
          : Number(existing.early_payoff_discount_percent);
      const nextActive = typeof isActive === 'boolean' ? isActive : Boolean(existing.is_active);
      const nextVersion = Number(existing.version) + 1;
      const now = new Date().toISOString();

      withTransaction(db, () => {
        db.prepare(`
          UPDATE installment_plans
          SET name = ?, term_months = ?, markup_percent = ?, down_payment_percent = ?,
              down_payment_required = ?, rounding_rule = ?, early_payoff_discount_percent = ?,
              is_active = ?, version = ?, updated_by = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextName,
          nextTerm,
          nextMarkup,
          nextDp,
          nextDpReq ? 1 : 0,
          nextRule,
          nextEarlyDiscount,
          nextActive ? 1 : 0,
          nextVersion,
          req.user!.id,
          now,
          planId
        );

        db.prepare(`
          INSERT INTO settings_history (id, setting_type, entity_id, old_value_json, new_value_json, reason, changed_by, created_at)
          VALUES (?, 'installment_plan_updated', ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          planId,
          JSON.stringify({
            version: existing.version,
            termMonths: existing.term_months,
            markupPercent: existing.markup_percent,
            downPaymentPercent: existing.down_payment_percent,
            roundingRule: existing.rounding_rule,
            isActive: Boolean(existing.is_active),
          }),
          JSON.stringify({
            version: nextVersion,
            termMonths: nextTerm,
            markupPercent: nextMarkup,
            downPaymentPercent: nextDp,
            roundingRule: nextRule,
            isActive: nextActive,
          }),
          (reason || 'Обновление параметров тарифа владельцем').trim(),
          req.user!.id,
          now
        );

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.email,
          action: 'INSTALLMENT_PLAN_UPDATED',
          entityType: 'installment_plan',
          entityId: planId,
          summary: `Обновлён тариф «${nextName}» до версии v${nextVersion} (срок: ${nextTerm} мес., наценка: ${nextMarkup}%, взнос: ${nextDp}%). Действующие договоры сохранили прежние условия.`,
        });
      });

      res.json({ id: planId, version: nextVersion });
    }
  );

  // ==================== 4. CLIENTS, SUPPLIERS & PURCHASES ====================

  router.post(
    '/clients',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      const { fullName, phone, secondaryPhone, documentRef, address, notes } = req.body as {
        fullName?: string;
        phone?: string;
        secondaryPhone?: string;
        documentRef?: string;
        address?: string;
        notes?: string;
      };

      if (!fullName || !fullName.trim() || !phone || !phone.trim()) {
        res.status(400).json({ error: 'ФИО и основной телефон клиента обязательны.' });
        return;
      }

      const normalizedPhone = normalizeRussianPhone(phone);
      if (!normalizedPhone) {
        res.status(400).json({
          error: 'Укажите корректный российский номер телефона клиента (например, +7 928 000-00-00).',
        });
        return;
      }

      // Prevent duplicate clients with the same canonical phone number
      const existingClients = db
        .prepare('SELECT id, full_name, phone FROM clients')
        .all() as Array<{ id: string; full_name: string; phone: string }>;
      const duplicateClient = existingClients.find(
        (c) => (normalizeRussianPhone(c.phone) || c.phone.trim()) === normalizedPhone
      );
      if (duplicateClient) {
        res.status(409).json({
          error: `Клиент с номером ${normalizedPhone} уже зарегистрирован в базе («${duplicateClient.full_name}»).`,
        });
        return;
      }

      const normalizedSecondary = secondaryPhone && secondaryPhone.trim()
        ? normalizeRussianPhone(secondaryPhone) || secondaryPhone.trim()
        : '';

      const id = `cli_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO clients (id, full_name, phone, secondary_phone, document_ref, address, notes, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id,
        fullName.trim(),
        normalizedPhone,
        normalizedSecondary,
        (documentRef || '').trim(),
        (address || '').trim(),
        (notes || '').trim(),
        req.user!.id,
        now
      );

      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.phone || req.user!.email,
        action: 'CLIENT_CREATED',
        entityType: 'client',
        entityId: id,
        summary: `Добавлен клиент «${fullName.trim()}» (${normalizedPhone}).`,
      });

      res.status(201).json({ id, phone: normalizedPhone });
    }
  );

  router.patch(
    '/clients/:id',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      const clientId = req.params.id;
      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as
        | {
            id: string;
            full_name: string;
            phone: string;
            secondary_phone: string;
            document_ref: string;
            address: string;
            notes: string;
            status: 'active' | 'archived';
          }
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Карточка клиента не найдена.' });
        return;
      }

      const { fullName, phone, secondaryPhone, documentRef, address, notes, status } = req.body as {
        fullName?: string;
        phone?: string;
        secondaryPhone?: string;
        documentRef?: string;
        address?: string;
        notes?: string;
        status?: 'active' | 'archived';
      };

      const nextFullName =
        typeof fullName === 'string' && fullName.trim() ? fullName.trim() : existing.full_name;
      if (!nextFullName) {
        res.status(400).json({ error: 'ФИО клиента не может быть пустым.' });
        return;
      }

      let nextPhone = existing.phone;
      if (phone !== undefined) {
        const normalized = normalizeRussianPhone(phone);
        if (!normalized) {
          res.status(400).json({
            error: 'Укажите корректный российский номер телефона клиента (например, +7 928 000-00-00).',
          });
          return;
        }
        const allClients = db
          .prepare('SELECT id, full_name, phone FROM clients WHERE id != ?')
          .all(clientId) as Array<{ id: string; full_name: string; phone: string }>;
        const dup = allClients.find(
          (c) => (normalizeRussianPhone(c.phone) || c.phone.trim()) === normalized
        );
        if (dup) {
          res.status(409).json({
            error: `Номер ${normalized} уже привязан к клиенту «${dup.full_name}».`,
          });
          return;
        }
        nextPhone = normalized;
      }

      const nextSecondary =
        secondaryPhone !== undefined
          ? secondaryPhone.trim()
            ? normalizeRussianPhone(secondaryPhone) || secondaryPhone.trim()
            : ''
          : existing.secondary_phone;
      const nextDocRef =
        documentRef !== undefined ? documentRef.trim() : existing.document_ref;
      const nextAddress =
        address !== undefined ? address.trim() : existing.address;
      const nextNotes =
        notes !== undefined ? notes.trim() : existing.notes;
      const nextStatus: 'active' | 'archived' =
        status && ['active', 'archived'].includes(status) ? status : existing.status;

      db.prepare(`
        UPDATE clients
        SET full_name = ?, phone = ?, secondary_phone = ?, document_ref = ?, address = ?, notes = ?, status = ?
        WHERE id = ?
      `).run(
        nextFullName,
        nextPhone,
        nextSecondary,
        nextDocRef,
        nextAddress,
        nextNotes,
        nextStatus,
        clientId
      );

      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.phone || req.user!.email,
        action: 'CLIENT_UPDATED',
        entityType: 'client',
        entityId: clientId,
        summary: `Обновлены данные клиента «${nextFullName}» (${nextPhone}, статус: ${nextStatus}).`,
      });

      res.json({
        id: clientId,
        fullName: nextFullName,
        phone: nextPhone,
        secondaryPhone: nextSecondary,
        documentRef: nextDocRef,
        address: nextAddress,
        notes: nextNotes,
        status: nextStatus,
      });
    }
  );

  router.post(
    '/suppliers',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      const { name, category, contactInfo, notes } = req.body as {
        name?: string;
        category?: string;
        contactInfo?: string;
        notes?: string;
      };

      if (!name || !name.trim()) {
        res.status(400).json({ error: 'Укажите название магазина или поставщика.' });
        return;
      }

      const id = `sup_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO suppliers (id, name, category, contact_info, notes, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(
        id,
        name.trim(),
        (category || 'Магазин электроники').trim(),
        (contactInfo || '').trim(),
        (notes || '').trim(),
        now
      );

      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'SUPPLIER_CREATED',
        entityType: 'supplier',
        entityId: id,
        summary: `Добавлен поставщик/магазин «${name.trim()}».`,
      });

      res.status(201).json({ id });
    }
  );

  router.post(
    '/purchases',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const {
          supplierId,
          clientId,
          itemName,
          itemCategory,
          quantity,
          purchasePriceKopecks,
          deliveryCostKopecks,
          otherCostKopecks,
          paidToSupplierKopecks,
          paymentAccountId,
          purchaseDate,
          notes,
        } = req.body as {
          supplierId?: string;
          clientId?: string | null;
          itemName?: string;
          itemCategory?: string;
          quantity?: number;
          purchasePriceKopecks?: number;
          deliveryCostKopecks?: number;
          otherCostKopecks?: number;
          paidToSupplierKopecks?: number;
          paymentAccountId?: string;
          purchaseDate?: string;
          notes?: string;
        };

        if (!supplierId || !itemName || !itemName.trim()) {
          res.status(400).json({ error: 'Выберите магазин/поставщика и укажите наименование товара.' });
          return;
        }

        const pPrice = Number(purchasePriceKopecks ?? 0);
        const dCost = Number(deliveryCostKopecks ?? 0);
        const oCost = Number(otherCostKopecks ?? 0);
        const totalCost = calculateTotalCostKopecks(pPrice, dCost, oCost);
        if (totalCost <= 0) {
          res.status(400).json({ error: 'Полная себестоимость закупки должна быть больше 0.' });
          return;
        }

        const paidSupplier = Number(paidToSupplierKopecks ?? pPrice);
        assertKopecks(paidSupplier, 'Оплачено поставщику', true);
        if (paidSupplier > pPrice) {
          res.status(400).json({ error: 'Сумма оплаты поставщику не может превышать цену покупки товара.' });
          return;
        }

        const supplierDebt = pPrice - paidSupplier;
        const id = `pur_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const eventDate = purchaseDate || now.slice(0, 10);
        const accId = paymentAccountId || 'acc_bank_main';

        withTransaction(db, () => {
          db.prepare(`
            INSERT INTO purchases (
              id, supplier_id, client_id, item_name, item_category, quantity,
              purchase_price_kopecks, delivery_cost_kopecks, other_cost_kopecks,
              total_cost_kopecks, paid_to_supplier_kopecks, supplier_debt_kopecks,
              handover_status, purchase_date, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
          `).run(
            id,
            supplierId,
            clientId || null,
            itemName.trim(),
            (itemCategory || 'Электроника').trim(),
            Math.max(1, Math.trunc(Number(quantity || 1))),
            pPrice,
            dCost,
            oCost,
            totalCost,
            paidSupplier,
            supplierDebt,
            eventDate,
            (notes || '').trim(),
            req.user!.id,
            now
          );

          if (paidSupplier > 0) {
            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, 'purchase_payment', 'Закупка товара', 'out', ?, 'purchase', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              `led_${crypto.randomUUID().slice(0, 8)}`,
              `idem_pur_${id}_supplier`,
              accId,
              paidSupplier,
              id,
              `Оплата поставщику за товар «${itemName.trim()}»`,
              eventDate,
              req.user!.id,
              now
            );
            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
              paidSupplier,
              accId
            );
          }

          const extraOutflow = dCost + oCost;
          if (extraOutflow > 0) {
            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, 'delivery_expense', 'Доставка и сопутствующие затраты', 'out', ?, 'purchase', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              `led_${crypto.randomUUID().slice(0, 8)}`,
              `idem_pur_${id}_delivery`,
              accId,
              extraOutflow,
              id,
              `Доставка / прямые затраты при закупке «${itemName.trim()}»`,
              eventDate,
              req.user!.id,
              now
            );
            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
              extraOutflow,
              accId
            );
          }

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'PURCHASE_CREATED',
            entityType: 'purchase',
            entityId: id,
            summary: `Оформлена закупка «${itemName.trim()}» на полную себестоимость ${formatRubles(totalCost)} (покупка: ${formatRubles(pPrice)}, доставка/прочее: ${formatRubles(dCost + oCost)}).`,
          });
        });

        res.status(201).json({ id, totalCostKopecks: totalCost });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка создания закупки.' });
      }
    }
  );

  router.post(
    '/purchases/:id/pay-supplier',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const purchaseId = req.params.id;
        const { amountKopecks, accountId } = req.body as {
          amountKopecks?: number;
          accountId?: string;
        };

        const pRow = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
          | Record<string, unknown>
          | undefined;
        if (!pRow) {
          res.status(404).json({ error: 'Закупка не найдена.' });
          return;
        }

        const amount = Number(amountKopecks || 0);
        assertKopecks(amount, 'Сумма погашения долга поставщику', false);
        const currentDebt = Number(pRow.supplier_debt_kopecks);
        if (amount > currentDebt) {
          res.status(400).json({ error: 'Сумма превышает текущее обязательство перед поставщиком.' });
          return;
        }

        const accId = accountId || 'acc_bank_main';
        const now = new Date().toISOString();

        withTransaction(db, () => {
          db.prepare(`
            UPDATE purchases
            SET paid_to_supplier_kopecks = paid_to_supplier_kopecks + ?,
                supplier_debt_kopecks = supplier_debt_kopecks - ?
            WHERE id = ?
          `).run(amount, amount, purchaseId);

          db.prepare(`
            INSERT INTO ledger_entries (
              id, idempotency_key, account_id, related_account_id, entry_type, category,
              direction, amount_kopecks, reference_type, reference_id, description,
              event_date, status, created_by, created_at
            ) VALUES (?, ?, ?, NULL, 'purchase_payment', 'Погашение обязательств перед поставщиком', 'out', ?, 'purchase', ?, ?, ?, 'confirmed', ?, ?)
          `).run(
            `led_${crypto.randomUUID().slice(0, 8)}`,
            `idem_sup_pay_${crypto.randomUUID()}`,
            accId,
            amount,
            purchaseId,
            `Доплата поставщику по закупке «${String(pRow.item_name)}»`,
            now.slice(0, 10),
            req.user!.id,
            now
          );

          db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
            amount,
            accId
          );

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'SUPPLIER_DEBT_PAID',
            entityType: 'purchase',
            entityId: purchaseId,
            summary: `Оплачено обязательство перед поставщиком на сумму ${formatRubles(amount)} по товару «${String(pRow.item_name)}».`,
          });
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка оплаты поставщику.' });
      }
    }
  );

  // ==================== 5. CONTRACTS & PAYMENT SCHEDULES ====================

  router.post('/contracts/preview', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    try {
      const calc = calculateContractAndSchedule(req.body);
      res.json(calc);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка расчёта договора.' });
    }
  });

  router.post(
    '/contracts',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const {
          clientId,
          purchaseId,
          planId,
          itemTitle,
          purchaseCostKopecks,
          deliveryCostKopecks,
          otherCostKopecks,
          markupPercent,
          downPaymentPercent,
          explicitDownPaymentKopecks,
          termMonths,
          roundingRule,
          scheduleType,
          startDate,
          customInstallmentsKopecks,
          downPaymentAccountId,
          downPaymentMethod,
          collectDownPaymentNow,
          confirmedCalculation,
          notes,
        } = req.body as {
          clientId?: string;
          purchaseId?: string | null;
          planId?: string | null;
          itemTitle?: string;
          purchaseCostKopecks?: number;
          deliveryCostKopecks?: number;
          otherCostKopecks?: number;
          markupPercent?: number;
          downPaymentPercent?: number;
          explicitDownPaymentKopecks?: number;
          termMonths?: number;
          roundingRule?: RoundingRule;
          scheduleType?: ScheduleType;
          startDate?: string;
          customInstallmentsKopecks?: number[];
          downPaymentAccountId?: string;
          downPaymentMethod?: 'cash' | 'bank_transfer';
          collectDownPaymentNow?: boolean;
          confirmedCalculation?: boolean;
          notes?: string;
        };

        if (!confirmedCalculation) {
          res.status(400).json({
            error: 'До подтверждения подробного расчёта и графика платежей договор не может быть активирован.',
          });
          return;
        }

        if (!clientId || !itemTitle || !itemTitle.trim()) {
          res.status(400).json({ error: 'Выберите клиента и укажите наименование товара.' });
          return;
        }

        const calc = calculateContractAndSchedule({
          purchaseCostKopecks: Number(purchaseCostKopecks || 0),
          deliveryCostKopecks: Number(deliveryCostKopecks || 0),
          otherCostKopecks: Number(otherCostKopecks || 0),
          markupPercent: Number(markupPercent ?? 25),
          downPaymentPercent: typeof downPaymentPercent === 'number' ? downPaymentPercent : undefined,
          explicitDownPaymentKopecks:
            typeof explicitDownPaymentKopecks === 'number' ? explicitDownPaymentKopecks : undefined,
          termMonths: Number(termMonths || 6),
          roundingRule: roundingRule || 'kopeck',
          scheduleType: scheduleType || 'equal',
          startDate: startDate || new Date().toISOString().slice(0, 10),
          customInstallmentsKopecks,
        });

        let planVersion = 1;
        if (planId) {
          const planRow = db
            .prepare('SELECT version FROM installment_plans WHERE id = ?')
            .get(planId) as { version: number } | undefined;
          if (planRow) {
            planVersion = planRow.version;
          }
        }

        const countRow = db.prepare('SELECT COUNT(*) as cnt FROM contracts').get() as { cnt: number };
        const nextNum = String(countRow.cnt + 1).padStart(4, '0');
        const contractNumber = `ДГ-2026-${nextNum}`;
        const contractId = `cnt_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();

        withTransaction(db, () => {
          db.prepare(`
            INSERT INTO contracts (
              id, contract_number, client_id, purchase_id, plan_id, plan_version,
              item_title, purchase_cost_kopecks, extra_cost_kopecks, total_cost_kopecks,
              markup_percent, sale_price_kopecks, down_payment_percent, down_payment_kopecks,
              financed_principal_kopecks, term_months, rounding_rule, schedule_type,
              start_date, current_schedule_version, status, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)
          `).run(
            contractId,
            contractNumber,
            clientId,
            purchaseId || null,
            planId || null,
            planVersion,
            itemTitle.trim(),
            calc.purchaseCostKopecks,
            calc.deliveryCostKopecks + calc.otherCostKopecks,
            calc.totalCostKopecks,
            calc.markupPercent,
            calc.salePriceKopecks,
            calc.downPaymentPercent,
            calc.downPaymentKopecks,
            calc.financedPrincipalKopecks,
            calc.termMonths,
            calc.roundingRule,
            calc.scheduleType,
            startDate || now.slice(0, 10),
            (notes || '').trim(),
            req.user!.id,
            now
          );

          db.prepare(`
            INSERT INTO schedule_versions (id, contract_id, version, change_reason, created_by, created_at)
            VALUES (?, ?, 1, 'Первоначальный график при оформлении договора', ?, ?)
          `).run(`sv_${contractId}_v1`, contractId, req.user!.id, now);

          const insertItem = db.prepare(`
            INSERT INTO schedule_items (
              id, contract_id, schedule_version, installment_number, due_date,
              original_due_date, planned_kopecks, paid_kopecks, status, promised_date, postpone_reason
            ) VALUES (?, ?, 1, ?, ?, ?, ?, 0, 'pending', NULL, '')
          `);

          for (const item of calc.schedule) {
            insertItem.run(
              `si_${contractId}_v1_${item.installmentNumber}`,
              contractId,
              item.installmentNumber,
              item.dueDate,
              item.dueDate,
              item.plannedKopecks
            );
          }

          if (purchaseId) {
            db.prepare(`UPDATE purchases SET handover_status = 'handed_over', client_id = ? WHERE id = ?`).run(
              clientId,
              purchaseId
            );
          }

          if (collectDownPaymentNow !== false && calc.downPaymentKopecks > 0) {
            const dpAcc = downPaymentAccountId || 'acc_cash_main';
            const dpMethod = downPaymentMethod || 'cash';
            const payId = `pay_dp_${contractId}`;

            db.prepare(`
              INSERT INTO payments (
                id, idempotency_key, client_id, contract_id, account_id, payment_method,
                amount_kopecks, allocated_kopecks, unallocated_kopecks, is_down_payment,
                status, event_date, notes, created_by, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'confirmed', ?, ?, ?, ?)
            `).run(
              payId,
              `idem_dp_${contractId}`,
              clientId,
              contractId,
              dpAcc,
              dpMethod,
              calc.downPaymentKopecks,
              calc.downPaymentKopecks,
              startDate || now.slice(0, 10),
              `Первоначальный взнос по договору ${contractNumber}`,
              req.user!.id,
              now
            );

            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, 'client_payment', 'Первоначальный взнос клиента', 'in', ?, 'payment', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              `led_dp_${contractId}`,
              `idem_led_dp_${contractId}`,
              dpAcc,
              calc.downPaymentKopecks,
              payId,
              `Первоначальный взнос по договору ${contractNumber} (${itemTitle.trim()})`,
              startDate || now.slice(0, 10),
              req.user!.id,
              now
            );

            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?').run(
              calc.downPaymentKopecks,
              dpAcc
            );
          }

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'CONTRACT_CREATED',
            entityType: 'contract',
            entityId: contractId,
            summary: `Оформлен договор ${contractNumber} на товар «${itemTitle.trim()}» (себестоимость: ${formatRubles(calc.totalCostKopecks)}, наценка: ${calc.markupPercent}%, цена продажи: ${formatRubles(calc.salePriceKopecks)}, взнос: ${formatRubles(calc.downPaymentKopecks)}, остаток: ${formatRubles(calc.financedPrincipalKopecks)}, срок: ${calc.termMonths} мес.).`,
          });
        });

        res.status(201).json({ id: contractId, contractNumber });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка оформления договора.' });
      }
    }
  );

  // Restructure contract schedule (creates new version while preserving historical schedule version!)
  router.post(
    '/contracts/:id/restructure',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const contractId = req.params.id;
        const { additionalMonths, nextStartDate, reason } = req.body as {
          additionalMonths?: number;
          nextStartDate?: string;
          reason?: string;
        };

        if (!reason || !reason.trim()) {
          res.status(400).json({ error: 'Укажите основание (причину) изменения графика платежей.' });
          return;
        }

        const cRow = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId) as
          | Record<string, unknown>
          | undefined;
        if (!cRow) {
          res.status(404).json({ error: 'Договор не найден.' });
          return;
        }

        const currentVer = Number(cRow.current_schedule_version);
        const currentItems = db
          .prepare(
            'SELECT * FROM schedule_items WHERE contract_id = ? AND schedule_version = ? ORDER BY installment_number ASC'
          )
          .all(contractId, currentVer) as Array<Record<string, unknown>>;

        const totalPaidSoFar = currentItems.reduce((sum, i) => sum + Number(i.paid_kopecks), 0);
        const financedPrincipal = Number(cRow.financed_principal_kopecks);
        const remainingPrincipal = financedPrincipal - totalPaidSoFar;

        if (remainingPrincipal <= 0) {
          res.status(400).json({ error: 'Остаток долга по договору уже равен 0.' });
          return;
        }

        const newMonthsCount = Math.max(1, Math.min(60, Math.trunc(Number(additionalMonths || 4))));
        const baseDate = nextStartDate || new Date().toISOString().slice(0, 10);
        const newVer = currentVer + 1;
        const now = new Date().toISOString();

        withTransaction(db, () => {
          // Historical version items remain untouched in schedule_items with schedule_version = currentVer
          db.prepare(`
            INSERT INTO schedule_versions (id, contract_id, version, change_reason, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(`sv_${contractId}_v${newVer}`, contractId, newVer, reason.trim(), req.user!.id, now);

          const insertItem = db.prepare(`
            INSERT INTO schedule_items (
              id, contract_id, schedule_version, installment_number, due_date,
              original_due_date, planned_kopecks, paid_kopecks, status, promised_date, postpone_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          `);

          let instNumber = 1;
          // Carry over already paid portion as locked historical row #1 in the new schedule if totalPaidSoFar > 0
          if (totalPaidSoFar > 0) {
            insertItem.run(
              `si_${contractId}_v${newVer}_paid`,
              contractId,
              newVer,
              instNumber++,
              String(cRow.start_date),
              String(cRow.start_date),
              totalPaidSoFar,
              totalPaidSoFar,
              'paid',
              'Оплачено до реструктуризации'
            );
          }

          const regPayment = Math.floor(remainingPrincipal / newMonthsCount);
          let accum = 0;
          for (let m = 0; m < newMonthsCount; m++) {
            const isLast = m === newMonthsCount - 1;
            const amount = isLast ? remainingPrincipal - accum : regPayment;
            accum += amount;
            const dueDate = calculateContractAndSchedule({
              purchaseCostKopecks: amount,
              deliveryCostKopecks: 0,
              otherCostKopecks: 0,
              markupPercent: 0,
              downPaymentPercent: 0,
              termMonths: m + 1,
              roundingRule: 'kopeck',
              scheduleType: 'equal',
              startDate: baseDate,
            }).schedule[m].dueDate;

            insertItem.run(
              `si_${contractId}_v${newVer}_${instNumber}`,
              contractId,
              newVer,
              instNumber++,
              dueDate,
              dueDate,
              amount,
              0,
              'pending',
              reason.trim()
            );
          }

          db.prepare(`
            UPDATE contracts
            SET current_schedule_version = ?, status = 'restructured'
            WHERE id = ?
          `).run(newVer, contractId);

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'CONTRACT_RESTRUCTURED',
            entityType: 'contract',
            entityId: contractId,
            summary: `Реструктурирован график договора ${String(cRow.contract_number)}: создана версия графика v${newVer} (предыдущая версия v${currentVer} сохранена в истории). Основание: ${reason.trim()}.`,
          });
        });

        res.json({ ok: true, newScheduleVersion: newVer });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка реструктуризации.' });
      }
    }
  );

  // Early payoff comparison calculator (4 options)
  router.post('/contracts/:id/early-payoff-preview', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const contractId = req.params.id;
    const { manualPayoffKopecks } = req.body as { manualPayoffKopecks?: number };

    const cRow = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId) as
      | Record<string, unknown>
      | undefined;
    if (!cRow) {
      res.status(404).json({ error: 'Договор не найден.' });
      return;
    }

    const items = db
      .prepare('SELECT * FROM schedule_items WHERE contract_id = ? AND schedule_version = ?')
      .all(contractId, Number(cRow.current_schedule_version)) as Array<Record<string, unknown>>;

    const remainingScheduleKopecks = items.reduce(
      (sum, i) => sum + Math.max(0, Number(i.planned_kopecks) - Number(i.paid_kopecks)),
      0
    );
    const unpaidInstallmentsCount = items.filter(
      (i) => Number(i.planned_kopecks) > Number(i.paid_kopecks)
    ).length;

    let planDiscountPercent = 30;
    if (cRow.plan_id) {
      const pRow = db
        .prepare('SELECT early_payoff_discount_percent FROM installment_plans WHERE id = ?')
        .get(String(cRow.plan_id)) as { early_payoff_discount_percent: number } | undefined;
      if (pRow) planDiscountPercent = Number(pRow.early_payoff_discount_percent);
    }

    const options = calculateEarlyPayoffComparison({
      totalCostKopecks: Number(cRow.total_cost_kopecks),
      salePriceKopecks: Number(cRow.sale_price_kopecks),
      downPaymentKopecks: Number(cRow.down_payment_kopecks),
      termMonths: Number(cRow.term_months),
      remainingScheduleKopecks,
      unpaidInstallmentsCount,
      planDiscountPercent,
      manualPayoffKopecks,
    });

    res.json({ options, remainingScheduleKopecks });
  });

  // Owner approval of early payoff & settlement
  router.post(
    '/contracts/:id/early-payoff-apply',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const contractId = req.params.id;
        const { payoffAmountKopecks, accountId, paymentMethod, reason } = req.body as {
          payoffAmountKopecks?: number;
          accountId?: string;
          paymentMethod?: 'cash' | 'bank_transfer';
          reason?: string;
        };

        const cRow = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId) as
          | Record<string, unknown>
          | undefined;
        if (!cRow) {
          res.status(404).json({ error: 'Договор не найден.' });
          return;
        }

        const currentVer = Number(cRow.current_schedule_version);
        const items = db
          .prepare('SELECT * FROM schedule_items WHERE contract_id = ? AND schedule_version = ?')
          .all(contractId, currentVer) as Array<Record<string, unknown>>;

        const remainingScheduleKopecks = items.reduce(
          (sum, i) => sum + Math.max(0, Number(i.planned_kopecks) - Number(i.paid_kopecks)),
          0
        );

        const finalPayoff = Number(payoffAmountKopecks ?? remainingScheduleKopecks);
        assertKopecks(finalPayoff, 'Сумма досрочного закрытия', true);
        if (finalPayoff > remainingScheduleKopecks) {
          res.status(400).json({ error: 'Сумма досрочного погашения не может превышать остаток по графику.' });
          return;
        }

        const discountKopecks = remainingScheduleKopecks - finalPayoff;
        const now = new Date().toISOString();
        const accId = accountId || 'acc_bank_main';
        const method = paymentMethod || 'bank_transfer';

        withTransaction(db, () => {
          const payId = `pay_early_${crypto.randomUUID().slice(0, 8)}`;
          if (finalPayoff > 0) {
            db.prepare(`
              INSERT INTO payments (
                id, idempotency_key, client_id, contract_id, account_id, payment_method,
                amount_kopecks, allocated_kopecks, unallocated_kopecks, is_down_payment,
                status, event_date, notes, created_by, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'confirmed', ?, ?, ?, ?)
            `).run(
              payId,
              `idem_early_${contractId}_${Date.now()}`,
              String(cRow.client_id),
              contractId,
              accId,
              method,
              finalPayoff,
              finalPayoff,
              now.slice(0, 10),
              `Досрочное закрытие договора ${String(cRow.contract_number)}. Скидка: ${formatRubles(discountKopecks)}`,
              req.user!.id,
              now
            );

            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, 'client_payment', 'Досрочное погашение договора', 'in', ?, 'payment', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              `led_early_${crypto.randomUUID().slice(0, 8)}`,
              `idem_led_early_${payId}`,
              accId,
              finalPayoff,
              payId,
              `Досрочное погашение договора ${String(cRow.contract_number)}`,
              now.slice(0, 10),
              req.user!.id,
              now
            );

            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?').run(
              finalPayoff,
              accId
            );
          }

          let remainingToAllocate = finalPayoff;
          for (const item of items) {
            const itemId = String(item.id);
            const planned = Number(item.planned_kopecks);
            const paid = Number(item.paid_kopecks);
            const need = Math.max(0, planned - paid);
            if (need <= 0) continue;

            const allocHere = Math.min(need, remainingToAllocate);
            remainingToAllocate -= allocHere;

            if (allocHere > 0) {
              db.prepare(`
                INSERT INTO payment_allocations (id, payment_id, contract_id, schedule_item_id, amount_kopecks, status, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
              `).run(
                `alloc_${crypto.randomUUID().slice(0, 8)}`,
                payId,
                contractId,
                itemId,
                allocHere,
                req.user!.id,
                now
              );
            }

            // Adjust planned_kopecks for discounted portion and mark paid/waived
            const newPaid = paid + allocHere;
            db.prepare(`
              UPDATE schedule_items
              SET planned_kopecks = CASE WHEN ? > 0 THEN ? ELSE planned_kopecks END,
                  paid_kopecks = ?,
                  status = CASE WHEN ? > 0 THEN 'paid' ELSE 'waived' END,
                  postpone_reason = ?
              WHERE id = ?
            `).run(newPaid, newPaid, newPaid, newPaid, reason || 'Досрочное погашение', itemId);
          }

          db.prepare(`
            UPDATE contracts
            SET status = 'completed', closing_discount_kopecks = ?, closed_at = ?
            WHERE id = ?
          `).run(discountKopecks, now, contractId);

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'CONTRACT_EARLY_PAYOFF_COMPLETED',
            entityType: 'contract',
            entityId: contractId,
            summary: `Договор ${String(cRow.contract_number)} закрыт досрочно. Внесено: ${formatRubles(finalPayoff)}, скидка с будущей наценки: ${formatRubles(discountKopecks)}.`,
          });
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка досрочного погашения.' });
      }
    }
  );

  // Return item / cancel contract
  router.post(
    '/contracts/:id/return',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const contractId = req.params.id;
        const { refundToClientKopecks, accountId, reason } = req.body as {
          refundToClientKopecks?: number;
          accountId?: string;
          reason?: string;
        };

        if (!reason || !reason.trim()) {
          res.status(400).json({ error: 'Укажите причину возврата товара / расторжения договора.' });
          return;
        }

        const cRow = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId) as
          | Record<string, unknown>
          | undefined;
        if (!cRow) {
          res.status(404).json({ error: 'Договор не найден.' });
          return;
        }

        const refund = Number(refundToClientKopecks || 0);
        assertKopecks(refund, 'Сумма возврата клиенту', true);
        const accId = accountId || 'acc_cash_main';
        const now = new Date().toISOString();

        withTransaction(db, () => {
          db.prepare(`UPDATE contracts SET status = 'returned', closed_at = ?, notes = ? WHERE id = ?`).run(
            now,
            `${String(cRow.notes || '')} | Возврат: ${reason.trim()}`,
            contractId
          );

          if (cRow.purchase_id) {
            db.prepare(`UPDATE purchases SET handover_status = 'returned' WHERE id = ?`).run(
              String(cRow.purchase_id)
            );
          }

          if (refund > 0) {
            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, 'client_refund', 'Возврат средств клиенту при расторжении', 'out', ?, 'contract', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              `led_ref_${crypto.randomUUID().slice(0, 8)}`,
              `idem_refund_${contractId}_${Date.now()}`,
              accId,
              refund,
              contractId,
              `Возврат клиенту при расторжении договора ${String(cRow.contract_number)}: ${reason.trim()}`,
              now.slice(0, 10),
              req.user!.id,
              now
            );

            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
              refund,
              accId
            );
          }

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'CONTRACT_RETURNED',
            entityType: 'contract',
            entityId: contractId,
            summary: `Оформлен возврат товара по договору ${String(cRow.contract_number)}. Возвращено клиенту: ${formatRubles(refund)}. Причина: ${reason.trim()}.`,
          });
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка оформления возврата.' });
      }
    }
  );

  // ==================== 6. PAYMENTS & MANUAL ALLOCATION ====================

  router.post(
    '/payments',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const {
          idempotencyKey,
          clientId,
          contractId,
          accountId,
          paymentMethod,
          amountKopecks,
          eventDate,
          notes,
          allocations,
        } = req.body as {
          idempotencyKey?: string;
          clientId?: string;
          contractId?: string | null;
          accountId?: string;
          paymentMethod?: 'cash' | 'bank_transfer';
          amountKopecks?: number;
          eventDate?: string;
          notes?: string;
          allocations?: Array<{ scheduleItemId: string; amountKopecks: number }>;
        };

        if (!idempotencyKey || !idempotencyKey.trim()) {
          res.status(400).json({ error: 'Отсутствует ключ идемпотентности операции (idempotencyKey).' });
          return;
        }

        // Check idempotency key to prevent duplicate payment registration
        const existingPay = db
          .prepare('SELECT id, amount_kopecks, allocated_kopecks, unallocated_kopecks FROM payments WHERE idempotency_key = ?')
          .get(idempotencyKey.trim()) as Record<string, unknown> | undefined;

        if (existingPay) {
          res.status(200).json({
            id: existingPay.id,
            idempotentReplay: true,
            message: 'Операция с этим ключом идемпотентности уже зарегистрирована ранее.',
          });
          return;
        }

        if (!clientId || !accountId) {
          res.status(400).json({ error: 'Выберите клиента и счёт/кассу поступления.' });
          return;
        }

        const amount = Number(amountKopecks || 0);
        assertKopecks(amount, 'Сумма поступления', false);

        const requestedAllocs = Array.isArray(allocations)
          ? allocations.filter((a) => a && Number(a.amountKopecks) > 0)
          : [];
        const totalRequestedAlloc = requestedAllocs.reduce((sum, a) => sum + Number(a.amountKopecks), 0);

        if (totalRequestedAlloc > amount) {
          res.status(400).json({
            error: `Сумма распределения (${formatRubles(totalRequestedAlloc)}) превышает сумму поступления (${formatRubles(amount)}).`,
          });
          return;
        }

        const payId = `pay_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const evDate = eventDate || now.slice(0, 10);
        const method = paymentMethod || 'bank_transfer';

        withTransaction(db, () => {
          db.prepare(`
            INSERT INTO payments (
              id, idempotency_key, client_id, contract_id, account_id, payment_method,
              amount_kopecks, allocated_kopecks, unallocated_kopecks, is_down_payment,
              status, event_date, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'confirmed', ?, ?, ?, ?)
          `).run(
            payId,
            idempotencyKey.trim(),
            clientId,
            contractId || null,
            accountId,
            method,
            amount,
            totalRequestedAlloc,
            amount - totalRequestedAlloc,
            evDate,
            (notes || '').trim(),
            req.user!.id,
            now
          );

          db.prepare(`
            INSERT INTO ledger_entries (
              id, idempotency_key, account_id, related_account_id, entry_type, category,
              direction, amount_kopecks, reference_type, reference_id, description,
              event_date, status, created_by, created_at
            ) VALUES (?, ?, ?, NULL, 'client_payment', 'Поступление от клиента', 'in', ?, 'payment', ?, ?, ?, 'confirmed', ?, ?)
          `).run(
            `led_${crypto.randomUUID().slice(0, 8)}`,
            `idem_led_${idempotencyKey.trim()}`,
            accountId,
            amount,
            payId,
            notes ? notes.trim() : 'Поступление от клиента по рассрочке',
            evDate,
            req.user!.id,
            now
          );

          db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?').run(
            amount,
            accountId
          );

          // Apply manual allocations if selected by user
          for (const alloc of requestedAllocs) {
            const allocAmt = Number(alloc.amountKopecks);
            assertKopecks(allocAmt, 'Сумма распределения по строке', false);

            const itemRow = db
              .prepare('SELECT * FROM schedule_items WHERE id = ?')
              .get(alloc.scheduleItemId) as Record<string, unknown> | undefined;

            if (!itemRow) {
              throw new Error(`Строка графика ${alloc.scheduleItemId} не найдена.`);
            }

            const remainingOnItem = Number(itemRow.planned_kopecks) - Number(itemRow.paid_kopecks);
            if (allocAmt > remainingOnItem) {
              throw new Error(
                `Сумма распределения по платежу №${String(itemRow.installment_number)} (${formatRubles(allocAmt)}) превышает остаток по этой строке (${formatRubles(remainingOnItem)}).`
              );
            }

            const newPaid = Number(itemRow.paid_kopecks) + allocAmt;
            const newStatus = newPaid === Number(itemRow.planned_kopecks) ? 'paid' : 'partial';

            db.prepare('UPDATE schedule_items SET paid_kopecks = ?, status = ? WHERE id = ?').run(
              newPaid,
              newStatus,
              alloc.scheduleItemId
            );

            db.prepare(`
              INSERT INTO payment_allocations (id, payment_id, contract_id, schedule_item_id, amount_kopecks, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            `).run(
              `alloc_${crypto.randomUUID().slice(0, 8)}`,
              payId,
              String(itemRow.contract_id),
              alloc.scheduleItemId,
              allocAmt,
              req.user!.id,
              now
            );

            checkAndMarkContractCompleted(db, String(itemRow.contract_id), now);
          }

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'PAYMENT_REGISTERED',
            entityType: 'payment',
            entityId: payId,
            summary: `Зарегистрирован платёж ${formatRubles(amount)} (распределено вручную: ${formatRubles(totalRequestedAlloc)}, нераспределённый остаток: ${formatRubles(amount - totalRequestedAlloc)}).`,
          });
        });

        res.status(201).json({ id: payId });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка регистрации платежа.' });
      }
    }
  );

  // Manual allocation of unallocated balance on an existing payment
  router.post(
    '/payments/:id/allocate',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentId = req.params.id;
        const { contractId, allocations } = req.body as {
          contractId?: string;
          allocations?: Array<{ scheduleItemId: string; amountKopecks: number }>;
        };

        const payRow = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
          | Record<string, unknown>
          | undefined;
        if (!payRow || payRow.status !== 'confirmed') {
          res.status(404).json({ error: 'Подтверждённый платёж не найден.' });
          return;
        }

        const requestedAllocs = Array.isArray(allocations)
          ? allocations.filter((a) => a && Number(a.amountKopecks) > 0)
          : [];
        if (requestedAllocs.length === 0) {
          res.status(400).json({ error: 'Выберите хотя бы один платёж графика и укажите сумму распределения.' });
          return;
        }

        const totalNewAlloc = requestedAllocs.reduce((sum, a) => sum + Number(a.amountKopecks), 0);
        const availableUnallocated = Number(payRow.unallocated_kopecks);

        if (totalNewAlloc > availableUnallocated) {
          res.status(400).json({
            error: `Нельзя распределить ${formatRubles(totalNewAlloc)}: доступный нераспределённый остаток поступления составляет ${formatRubles(availableUnallocated)}.`,
          });
          return;
        }

        const now = new Date().toISOString();

        withTransaction(db, () => {
          for (const alloc of requestedAllocs) {
            const allocAmt = Number(alloc.amountKopecks);
            assertKopecks(allocAmt, 'Сумма распределения', false);

            const itemRow = db
              .prepare('SELECT * FROM schedule_items WHERE id = ?')
              .get(alloc.scheduleItemId) as Record<string, unknown> | undefined;
            if (!itemRow) {
              throw new Error('Выбранный платёж графика не найден.');
            }

            const remainingOnItem = Number(itemRow.planned_kopecks) - Number(itemRow.paid_kopecks);
            if (allocAmt > remainingOnItem) {
              throw new Error(
                `Сумма (${formatRubles(allocAmt)}) превышает остаток долга по платежу №${String(itemRow.installment_number)} (${formatRubles(remainingOnItem)}).`
              );
            }

            const newPaid = Number(itemRow.paid_kopecks) + allocAmt;
            const newStatus = newPaid === Number(itemRow.planned_kopecks) ? 'paid' : 'partial';

            db.prepare('UPDATE schedule_items SET paid_kopecks = ?, status = ? WHERE id = ?').run(
              newPaid,
              newStatus,
              alloc.scheduleItemId
            );

            db.prepare(`
              INSERT INTO payment_allocations (id, payment_id, contract_id, schedule_item_id, amount_kopecks, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            `).run(
              `alloc_${crypto.randomUUID().slice(0, 8)}`,
              paymentId,
              String(itemRow.contract_id),
              alloc.scheduleItemId,
              allocAmt,
              req.user!.id,
              now
            );

            checkAndMarkContractCompleted(db, String(itemRow.contract_id), now);
          }

          const nextAllocated = Number(payRow.allocated_kopecks) + totalNewAlloc;
          const nextUnallocated = Number(payRow.amount_kopecks) - nextAllocated;

          db.prepare(`
            UPDATE payments
            SET allocated_kopecks = ?,
                unallocated_kopecks = ?,
                contract_id = COALESCE(contract_id, ?)
            WHERE id = ?
          `).run(nextAllocated, nextUnallocated, contractId || null, paymentId);

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'PAYMENT_MANUALLY_ALLOCATED',
            entityType: 'payment',
            entityId: paymentId,
            summary: `Вручную распределено ${formatRubles(totalNewAlloc)} из платежа ${paymentId}. Остаток нераспределённых средств: ${formatRubles(nextUnallocated)}.`,
          });
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка распределения платежа.' });
      }
    }
  );

  // Reversal (storno) of a confirmed payment without deleting historical records
  router.post(
    '/payments/:id/reverse',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentId = req.params.id;
        const { reason } = req.body as { reason?: string };
        if (!reason || !reason.trim()) {
          res.status(400).json({ error: 'Для сторнирования платежа обязательно укажите причину.' });
          return;
        }

        const payRow = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
          | Record<string, unknown>
          | undefined;
        if (!payRow || payRow.status !== 'confirmed') {
          res.status(400).json({ error: 'Платёж не найден или уже был сторнирован.' });
          return;
        }
        if (payRow.is_down_payment) {
          res.status(400).json({
            error: 'Для возврата первоначального взноса используйте операцию возврата/расторжения договора.',
          });
          return;
        }

        const now = new Date().toISOString();

        withTransaction(db, () => {
          const activeAllocs = db
            .prepare("SELECT * FROM payment_allocations WHERE payment_id = ? AND status = 'active'")
            .all(paymentId) as Array<Record<string, unknown>>;

          for (const alloc of activeAllocs) {
            const itemRow = db
              .prepare('SELECT * FROM schedule_items WHERE id = ?')
              .get(String(alloc.schedule_item_id)) as Record<string, unknown> | undefined;
            if (itemRow) {
              const revertedPaid = Math.max(0, Number(itemRow.paid_kopecks) - Number(alloc.amount_kopecks));
              const revertedStatus = revertedPaid === 0 ? 'pending' : 'partial';
              db.prepare('UPDATE schedule_items SET paid_kopecks = ?, status = ? WHERE id = ?').run(
                revertedPaid,
                revertedStatus,
                String(alloc.schedule_item_id)
              );
              db.prepare("UPDATE contracts SET status = 'active', closed_at = NULL WHERE id = ?").run(
                String(alloc.contract_id)
              );
            }
            db.prepare("UPDATE payment_allocations SET status = 'reversed' WHERE id = ?").run(
              String(alloc.id)
            );
          }

          db.prepare(`
            UPDATE payments
            SET status = 'reversed', reversal_reason = ?, reversed_by = ?
            WHERE id = ?
          `).run(reason.trim(), req.user!.id, paymentId);

          // Mark original ledger entry reversed and record audit
          const origLedger = db
            .prepare("SELECT * FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = ?")
            .get(paymentId) as Record<string, unknown> | undefined;

          if (origLedger) {
            db.prepare("UPDATE ledger_entries SET status = 'reversed', reversal_reason = ? WHERE id = ?").run(
              reason.trim(),
              String(origLedger.id)
            );
          }

          db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
            Number(payRow.amount_kopecks),
            String(payRow.account_id)
          );

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'PAYMENT_REVERSED',
            entityType: 'payment',
            entityId: paymentId,
            summary: `Сторнирован платёж ${paymentId} на сумму ${formatRubles(Number(payRow.amount_kopecks))}. Причина: ${reason.trim()}.`,
          });
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка сторнирования платежа.' });
      }
    }
  );

  // ==================== 7. OVERDUE MANAGEMENT (NO AUTO FINES) ====================

  router.post(
    '/overdues/contact',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      const { contractId, scheduleItemId, contactChannel, summary, promisedDate, agreedNewDueDate } =
        req.body as {
          contractId?: string;
          scheduleItemId?: string;
          contactChannel?: 'phone' | 'messenger' | 'in_person';
          summary?: string;
          promisedDate?: string | null;
          agreedNewDueDate?: string | null;
        };

      if (!contractId || !scheduleItemId || !summary || !summary.trim()) {
        res.status(400).json({ error: 'Укажите комментарий по результату связи с клиентом.' });
        return;
      }

      const now = new Date().toISOString();
      const channel = contactChannel || 'phone';

      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO overdue_contacts (id, contract_id, schedule_item_id, contact_channel, summary, promised_date, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `oc_${crypto.randomUUID().slice(0, 8)}`,
          contractId,
          scheduleItemId,
          channel,
          summary.trim(),
          promisedDate || null,
          req.user!.id,
          now
        );

        if (agreedNewDueDate) {
          db.prepare(`
            UPDATE schedule_items
            SET due_date = ?, promised_date = ?, status = 'pending', postpone_reason = ?
            WHERE id = ?
          `).run(agreedNewDueDate, promisedDate || agreedNewDueDate, summary.trim(), scheduleItemId);
        } else if (promisedDate) {
          db.prepare('UPDATE schedule_items SET promised_date = ? WHERE id = ?').run(
            promisedDate,
            scheduleItemId
          );
        }

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.email,
          action: 'OVERDUE_CONTACT_LOGGED',
          entityType: 'schedule_item',
          entityId: scheduleItemId,
          summary: `Зафиксирован контакт по просрочке (${channel}): «${summary.trim()}»${promisedDate ? `, обещанная дата: ${promisedDate}` : ''}${agreedNewDueDate ? `, согласован перенос срока на ${agreedNewDueDate}` : ''}. Штрафы не начислялись.`,
        });
      });

      res.status(201).json({ ok: true });
    }
  );

  // ==================== 8. CASH, BANK & LEDGER OPERATIONS ====================

  router.post(
    '/finance/ledger',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const {
          idempotencyKey,
          accountId,
          targetAccountId,
          entryType,
          category,
          amountKopecks,
          description,
          eventDate,
        } = req.body as {
          idempotencyKey?: string;
          accountId?: string;
          targetAccountId?: string;
          entryType?:
            | 'operating_expense'
            | 'owner_injection'
            | 'owner_withdrawal'
            | 'internal_transfer';
          category?: string;
          amountKopecks?: number;
          description?: string;
          eventDate?: string;
        };

        if (!accountId || !entryType || !description || !description.trim()) {
          res.status(400).json({ error: 'Заполните счёт, тип операции и назначение.' });
          return;
        }

        if ((entryType === 'owner_injection' || entryType === 'owner_withdrawal') && req.user!.role !== 'owner') {
          res.status(403).json({
            error: 'Собственные пополнения и личные изъятия может проводить только владелец бизнеса.',
          });
          return;
        }

        const amount = Number(amountKopecks || 0);
        assertKopecks(amount, 'Сумма операции', false);
        const now = new Date().toISOString();
        const evDate = eventDate || now.slice(0, 10);
        const idem = (idempotencyKey || `idem_fin_${crypto.randomUUID()}`).trim();

        withTransaction(db, () => {
          if (entryType === 'internal_transfer') {
            if (!targetAccountId || targetAccountId === accountId) {
              throw new Error('Для внутреннего перевода выберите другой счёт зачисления.');
            }
            const outId = `led_${crypto.randomUUID().slice(0, 8)}`;
            const inId = `led_${crypto.randomUUID().slice(0, 8)}`;

            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, ?, 'internal_transfer_out', 'Внутренний перевод между счетами', 'out', ?, 'transfer', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              outId,
              `${idem}_out`,
              accountId,
              targetAccountId,
              amount,
              inId,
              description.trim(),
              evDate,
              req.user!.id,
              now
            );

            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, ?, 'internal_transfer_in', 'Внутренний перевод между счетами', 'in', ?, 'transfer', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              inId,
              `${idem}_in`,
              targetAccountId,
              accountId,
              amount,
              outId,
              description.trim(),
              evDate,
              req.user!.id,
              now
            );

            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks - ? WHERE id = ?').run(
              amount,
              accountId
            );
            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?').run(
              amount,
              targetAccountId
            );
          } else {
            const direction = entryType === 'owner_injection' ? 'in' : 'out';
            const signedDelta = direction === 'in' ? amount : -amount;
            const ledId = `led_${crypto.randomUUID().slice(0, 8)}`;

            db.prepare(`
              INSERT INTO ledger_entries (
                id, idempotency_key, account_id, related_account_id, entry_type, category,
                direction, amount_kopecks, reference_type, reference_id, description,
                event_date, status, created_by, created_at
              ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'manual', ?, ?, ?, 'confirmed', ?, ?)
            `).run(
              ledId,
              idem,
              accountId,
              entryType,
              (category || 'Операционная деятельность').trim(),
              direction,
              amount,
              ledId,
              description.trim(),
              evDate,
              req.user!.id,
              now
            );

            db.prepare('UPDATE financial_accounts SET balance_kopecks = balance_kopecks + ? WHERE id = ?').run(
              signedDelta,
              accountId
            );
          }

          recordAudit(db, {
            actorUserId: req.user!.id,
            actorEmail: req.user!.email,
            action: 'LEDGER_OPERATION_RECORDED',
            entityType: 'ledger',
            entityId: idem,
            summary: `Проведена финансовая операция (${entryType}) на сумму ${formatRubles(amount)}: ${description.trim()}.`,
          });
        });

        res.status(201).json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка проведения операции.' });
      }
    }
  );

  // ==================== 9. DOCUMENTS & SAFE CSV EXPORT ====================

  router.post(
    '/documents/upload',
    requireAuth,
    requireRoles(['owner', 'staff']),
    (req: AuthenticatedRequest, res: Response) => {
      const { entityType, entityId, docCategory, title, originalFilename, mimeType, contentBase64 } =
        req.body as {
          entityType?: 'client' | 'contract' | 'purchase' | 'payment' | 'return';
          entityId?: string;
          docCategory?: string;
          title?: string;
          originalFilename?: string;
          mimeType?: string;
          contentBase64?: string;
        };

      if (!entityType || !entityId || !title || !originalFilename || !contentBase64) {
        res.status(400).json({ error: 'Заполните обязательные реквизиты документа и выберите файл.' });
        return;
      }

      const buffer = Buffer.from(contentBase64, 'base64');
      const sigCheck = validateUploadedFileSignature(buffer, mimeType || '', originalFilename);
      if (!sigCheck.valid) {
        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.email,
          action: 'DOCUMENT_UPLOAD_REJECTED',
          entityType: 'document',
          entityId,
          summary: `Отклонена загрузка файла «${originalFilename}»: ${sigCheck.reason}`,
        });
        res.status(400).json({ error: sigCheck.reason });
        return;
      }

      const id = `doc_${crypto.randomUUID().slice(0, 8)}`;
      const storedFilename = `${crypto.randomUUID()}.${(originalFilename.split('.').pop() || 'bin').toLowerCase()}`;
      const { sha256 } = writePrivateDocumentBuffer(storedFilename, buffer);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO documents (
          id, entity_type, entity_id, doc_category, title, original_filename,
          stored_filename, mime_type, size_bytes, sha256_hash, content_base64, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        entityType,
        entityId,
        docCategory || 'contract_scan',
        title.trim(),
        originalFilename.replace(/[^a-zA-Z0-9._\-\u0400-\u04FF ]/g, '_'),
        storedFilename,
        sigCheck.detectedMime,
        buffer.length,
        sha256,
        contentBase64,
        req.user!.id,
        now
      );

      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.phone || req.user!.email,
        action: 'DOCUMENT_UPLOADED',
        entityType: 'document',
        entityId: id,
        summary: `Загружен проверенный документ «${title.trim()}» (${sigCheck.detectedMime}, ${buffer.length} байт, SHA-256: ${sha256.slice(0, 12)}...).`,
      });

      res.status(201).json({ id, sha256 });
    }
  );

  // Private authenticated document download (no direct unauthenticated public URLs)
  router.get(
    '/documents/:id/download',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const docId = req.params.id;
        const row = db
          .prepare(
            'SELECT id, title, original_filename, stored_filename, mime_type, size_bytes, sha256_hash, content_base64 FROM documents WHERE id = ?'
          )
          .get(docId) as
          | {
              id: string;
              title: string;
              original_filename: string;
              stored_filename: string;
              mime_type: string;
              size_bytes: number;
              sha256_hash: string;
              content_base64: string;
            }
          | undefined;

        if (!row) {
          res.status(404).json({ error: 'Документ не найден.' });
          return;
        }

        const buffer = readPrivateDocumentBuffer(
          row.stored_filename,
          row.content_base64,
          row.sha256_hash
        );

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone || req.user!.email,
          action: 'DOCUMENT_DOWNLOADED',
          entityType: 'document',
          entityId: row.id,
          summary: `Скачан защищённый документ «${row.title}» (${row.original_filename}, SHA-256 проверен).`,
        });

        const safeDownloadName = row.original_filename.replace(/["\\\r\n]/g, '_');
        res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${ encodeURIComponent(safeDownloadName) }"`
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(buffer);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Ошибка чтения защищённого файла.',
        });
      }
    }
  );

  // Owner-only document deletion with audit trail and physical private file cleanup
  router.delete(
    '/documents/:id',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const docId = req.params.id;
      const row = db
        .prepare('SELECT id, title, original_filename, stored_filename, entity_type, entity_id FROM documents WHERE id = ?')
        .get(docId) as
        | {
            id: string;
            title: string;
            original_filename: string;
            stored_filename: string;
            entity_type: string;
            entity_id: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ error: 'Документ не найден.' });
        return;
      }

      withTransaction(db, () => {
        db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone || req.user!.email,
          action: 'DOCUMENT_DELETED',
          entityType: 'document',
          entityId: docId,
          summary: `Удалён документ «${row.title}» (${row.original_filename}) из привязки ${row.entity_type}:${row.entity_id}.`,
        });
      });

      removePrivateDocumentFile(row.stored_filename);
      res.json({ ok: true });
    }
  );

  router.get('/reports/export/csv', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const from = String(req.query.from || '2026-01-01');
    const to = String(req.query.to || '2026-12-31');

    const rows = db
      .prepare(
        `
        SELECT l.event_date, l.entry_type, l.direction, l.amount_kopecks, l.category, l.description, fa.name as account_name
        FROM ledger_entries l
        JOIN financial_accounts fa ON fa.id = l.account_id
        WHERE l.status = 'confirmed' AND l.event_date >= ? AND l.event_date <= ?
        ORDER BY l.event_date DESC, l.created_at DESC
      `
      )
      .all(from, to) as Array<Record<string, unknown>>;

    const csvLines = [
      toSafeCsvRow(['Дата', 'Счёт / Касса', 'Тип операции', 'Направление', 'Категория', 'Сумма (₽)', 'Описание']),
      ...rows.map((r) =>
        toSafeCsvRow([
          String(r.event_date),
          String(r.account_name),
          String(r.entry_type),
          r.direction === 'in' ? 'Приход' : 'Расход',
          String(r.category),
          (Number(r.amount_kopecks) / 100).toFixed(2).replace('.', ','),
          String(r.description),
        ])
      ),
    ];

    recordAudit(db, {
      actorUserId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'REPORT_EXPORTED_CSV',
      entityType: 'report',
      entityId: `${from}_${to}`,
      summary: `Экспортирован отчёт о движении средств в CSV/Excel за период ${from} — ${to}.`,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_${from}_${to}.csv"`);
    // UTF-8 BOM for Excel compatibility with Cyrillic
    res.send('\uFEFF' + csvLines.join('\r\n'));
  });

  // ==================== 10. ADMIN USER MANAGEMENT & BACKUPS ====================

  function mapUserRowToSafeDTO(u: Record<string, unknown>) {
    return {
      id: String(u.id),
      email: String(u.email),
      fullName: String(u.full_name),
      phone: String(u.phone || ''),
      role: String(u.role) as UserRole,
      status: (String(u.status) === 'active' ? 'active' : 'blocked') as UserStatus,
      mustChangePassword: Boolean(u.must_change_password),
      passwordChangedAt: u.password_changed_at ? String(u.password_changed_at) : null,
      mfaEnabled: Boolean(u.mfa_enabled),
      approvedBy: u.approved_by ? String(u.approved_by) : null,
      approvedAt: u.approved_at ? String(u.approved_at) : null,
      createdAt: String(u.created_at),
    };
  }

  // List all users (Admin only)
  router.get(
    '/users',
    requireAuth,
    requireRoles(['owner']),
    (_req: AuthenticatedRequest, res: Response) => {
      const rows = db
        .prepare(
          'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at FROM users ORDER BY created_at DESC'
        )
        .all() as Array<Record<string, unknown>>;
      res.json(rows.map(mapUserRowToSafeDTO));
    }
  );

  // Get single user profile (Admin or self; prevents IDOR/BOLA)
  router.get('/users/:id', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const targetId = req.params.id;
    if (req.user!.role !== 'owner' && req.user!.id !== targetId) {
      recordAudit(db, {
        actorUserId: req.user!.id,
        actorEmail: req.user!.phone,
        action: 'IDOR_ATTEMPT_BLOCKED',
        entityType: 'security',
        entityId: targetId,
        summary: `Предотвращена попытка доступа пользователя ${req.user!.phone} к чужому профилю ${targetId}.`,
      });
      res.status(403).json({ error: 'Доступ к данным другого пользователя запрещён.' });
      return;
    }

    const row = db
      .prepare(
        'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at FROM users WHERE id = ?'
      )
      .get(targetId) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Пользователь не найден.' });
      return;
    }
    res.json(mapUserRowToSafeDTO(row));
  });

  // Create user manually (Admin only — no self-registration)
  router.post(
    '/users',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const { phone, password, fullName, role, status, mustChangePassword } = req.body as {
        phone?: unknown;
        password?: unknown;
        fullName?: unknown;
        role?: unknown;
        status?: unknown;
        mustChangePassword?: unknown;
      };

      const normalizedPhone = normalizeRussianPhone(phone);
      if (!normalizedPhone) {
        res.status(400).json({
          error: 'Укажите корректный российский номер телефона (например, +7 928 000-00-00).',
        });
        return;
      }

      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        res.status(400).json({
          error: 'Первоначальный пароль должен содержать от 8 до 128 символов.',
        });
        return;
      }

      const assignedRole: UserRole =
        typeof role === 'string' && ['owner', 'staff', 'readonly'].includes(role)
          ? (role as UserRole)
          : 'staff';

      const assignedStatus: UserStatus =
        typeof status === 'string' && status === 'blocked' ? 'blocked' : 'active';

      const requireChange = mustChangePassword === undefined ? 1 : mustChangePassword ? 1 : 0;

      const existing = db
        .prepare('SELECT id FROM users WHERE phone = ?')
        .get(normalizedPhone) as { id: string } | undefined;
      if (existing) {
        res.status(409).json({
          error: 'Пользователь с таким номером телефона уже существует.',
        });
        return;
      }

      const nowIso = new Date().toISOString();
      const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
      const displayName =
        typeof fullName === 'string' && fullName.trim()
          ? fullName.trim()
          : `Пользователь ${normalizedPhone}`;
      const syntheticEmail = `${normalizedPhone.replace('+', '')}@phone.rassrochka.local`;

      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO users (
            id, email, full_name, phone, password_hash, role, status,
            must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`
        ).run(
          userId,
          syntheticEmail,
          displayName,
          normalizedPhone,
          hashPassword(password),
          assignedRole,
          assignedStatus,
          requireChange,
          req.user!.id,
          nowIso,
          nowIso
        );

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'ADMIN_USER_CREATED',
          entityType: 'user',
          entityId: userId,
          summary: `Администратор создал учётную запись ${normalizedPhone} (роль: ${assignedRole}, статус: ${assignedStatus}).`,
        });
      });

      const createdRow = db
        .prepare(
          'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at FROM users WHERE id = ?'
        )
        .get(userId) as Record<string, unknown>;

      res.status(201).json(mapUserRowToSafeDTO(createdRow));
    }
  );

  // Update user phone, fullName, role, or status (Admin only)
  router.patch(
    '/users/:id',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const targetId = req.params.id;
      const existing = db
        .prepare('SELECT id, phone, full_name, role, status FROM users WHERE id = ?')
        .get(targetId) as
        | { id: string; phone: string; full_name: string; role: UserRole; status: string }
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Пользователь не найден.' });
        return;
      }

      const { phone, fullName, role, status } = req.body as {
        phone?: unknown;
        fullName?: unknown;
        role?: unknown;
        status?: unknown;
      };

      let nextPhone = existing.phone;
      if (phone !== undefined) {
        const normalized = normalizeRussianPhone(phone);
        if (!normalized) {
          res.status(400).json({ error: 'Укажите корректный российский номер телефона.' });
          return;
        }
        if (normalized !== existing.phone) {
          const dup = db
            .prepare('SELECT id FROM users WHERE phone = ? AND id != ?')
            .get(normalized, targetId);
          if (dup) {
            res.status(409).json({ error: 'Этот номер телефона уже занят другим пользователем.' });
            return;
          }
          nextPhone = normalized;
        }
      }

      const nextName =
        typeof fullName === 'string' && fullName.trim() ? fullName.trim() : existing.full_name;

      let nextRole = existing.role;
      if (role !== undefined) {
        if (typeof role !== 'string' || !['owner', 'staff', 'readonly'].includes(role)) {
          res.status(400).json({ error: 'Недопустимая роль.' });
          return;
        }
        if (targetId === req.user!.id && role !== 'owner') {
          res.status(400).json({ error: 'Администратор не может понизить собственную роль.' });
          return;
        }
        nextRole = role as UserRole;
      }

      let nextStatus = existing.status;
      if (status !== undefined) {
        if (typeof status !== 'string' || !['active', 'blocked'].includes(status)) {
          res.status(400).json({ error: 'Недопустимый статус аккаунта.' });
          return;
        }
        if (targetId === req.user!.id && status === 'blocked') {
          res.status(400).json({ error: 'Администратор не может заблокировать собственный аккаунт.' });
          return;
        }
        nextStatus = status;
      }

      const nowIso = new Date().toISOString();
      const shouldRevokeSessions =
        nextStatus === 'blocked' || nextRole !== existing.role || nextPhone !== existing.phone;

      withTransaction(db, () => {
        db.prepare(
          'UPDATE users SET phone = ?, full_name = ?, role = ?, status = ? WHERE id = ?'
        ).run(nextPhone, nextName, nextRole, nextStatus, targetId);

        if (nextStatus === 'active') {
          db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(
            targetId
          );
          resetRateLimitBucket(db, `acct:${nextPhone}`);
        }

        if (shouldRevokeSessions) {
          db.prepare(
            'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
          ).run(nowIso, targetId);
        }

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'ADMIN_USER_UPDATED',
          entityType: 'user',
          entityId: targetId,
          summary: `Администратор обновил аккаунт ${nextPhone} (роль: ${nextRole}, статус: ${nextStatus}${shouldRevokeSessions ? ', сессии отозваны' : ''}).`,
        });
      });

      const updatedRow = db
        .prepare(
          'SELECT id, email, full_name, phone, role, status, must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at FROM users WHERE id = ?'
        )
        .get(targetId) as Record<string, unknown>;

      res.json(mapUserRowToSafeDTO(updatedRow));
    }
  );

  // Reset user password by administrator (revokes all active sessions immediately)
  router.post(
    '/users/:id/reset-password',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const targetId = req.params.id;
      const { newPassword, mustChangePassword } = req.body as {
        newPassword?: unknown;
        mustChangePassword?: unknown;
      };

      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        res.status(400).json({ error: 'Новый пароль должен содержать от 8 до 128 символов.' });
        return;
      }

      const targetUser = db
        .prepare('SELECT id, phone FROM users WHERE id = ?')
        .get(targetId) as { id: string; phone: string } | undefined;

      if (!targetUser) {
        res.status(404).json({ error: 'Пользователь не найден.' });
        return;
      }

      const nowIso = new Date().toISOString();
      const requireChange = mustChangePassword === undefined ? 1 : mustChangePassword ? 1 : 0;

      withTransaction(db, () => {
        db.prepare(
          `UPDATE users
           SET password_hash = ?, must_change_password = ?, password_changed_at = ?,
               failed_login_attempts = 0, locked_until = NULL
           WHERE id = ?`
        ).run(hashPassword(newPassword), requireChange, nowIso, targetId);

        resetRateLimitBucket(db, `acct:${targetUser.phone}`);

        // Revoke all active sessions of that user
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
          nowIso,
          targetId
        );

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'ADMIN_USER_PASSWORD_RESET',
          entityType: 'user',
          entityId: targetId,
          summary: `Администратор сбросил пароль пользователя ${targetUser.phone}. Все старые сессии отозваны.`,
        });
      });

      res.json({ ok: true });
    }
  );

  router.post(
    '/users/:id/approve',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const targetId = req.params.id;
      const { role } = req.body as { role?: UserRole };
      const assignedRole: UserRole =
        role && ['staff', 'readonly'].includes(role) ? role : 'staff';
      const now = new Date().toISOString();

      const targetUser = db
        .prepare('SELECT id, phone FROM users WHERE id = ?')
        .get(targetId) as { id: string; phone: string } | undefined;
      if (!targetUser) {
        res.status(404).json({ error: 'Пользователь не найден.' });
        return;
      }

      withTransaction(db, () => {
        db.prepare(`
          UPDATE users
          SET status = 'active', role = ?, failed_login_attempts = 0, locked_until = NULL, approved_by = ?, approved_at = ?
          WHERE id = ?
        `).run(assignedRole, req.user!.id, now, targetId);
        resetRateLimitBucket(db, `acct:${targetUser.phone}`);

        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'USER_ACTIVATED',
          entityType: 'user',
          entityId: targetId,
          summary: `Администратор активировал аккаунт ${targetUser.phone} (роль: «${assignedRole}»).`,
        });
      });

      res.json({ ok: true });
    }
  );

  router.post(
    '/users/:id/block',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const targetId = req.params.id;
      if (targetId === req.user!.id) {
        res.status(400).json({ error: 'Администратор не может заблокировать собственный аккаунт.' });
        return;
      }
      const now = new Date().toISOString();

      withTransaction(db, () => {
        db.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").run(targetId);
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
          now,
          targetId
        );
        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'USER_BLOCKED_AND_SESSIONS_REVOKED',
          entityType: 'user',
          entityId: targetId,
          summary: `Аккаунт ${targetId} заблокирован администратором, все активные сессии немедленно отозваны.`,
        });
      });

      res.json({ ok: true });
    }
  );

  router.post(
    '/users/:id/role',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      const targetId = req.params.id;
      const { role } = req.body as { role?: UserRole };
      if (!role || !['owner', 'staff', 'readonly'].includes(role)) {
        res.status(400).json({ error: 'Недопустимая роль.' });
        return;
      }
      if (targetId === req.user!.id && role !== 'owner') {
        res.status(400).json({ error: 'Администратор не может понизить собственную роль.' });
        return;
      }

      const nowIso = new Date().toISOString();
      withTransaction(db, () => {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
        db.prepare(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
        ).run(nowIso, targetId);
        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone,
          action: 'USER_ROLE_CHANGED',
          entityType: 'user',
          entityId: targetId,
          summary: `Роль пользователя ${targetId} изменена на «${role}» (сессии обновлены).`,
        });
      });

      res.json({ ok: true });
    }
  );

  router.post(
    '/security/backups',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const bkp = createEncryptedBackup(db, req.user!.id, req.user!.email);
        res.status(201).json(bkp);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка резервного копирования.' });
      }
    }
  );

  router.post(
    '/security/backups/:id/verify',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = verifyEncryptedBackup(db, req.params.id, req.user!.id, req.user!.phone || req.user!.email);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка проверки копии.' });
      }
    }
  );

  router.post(
    '/security/backups/restore-file',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const { filename, envelopeContent } = req.body as {
          filename?: string;
          envelopeContent?: string;
        };
        if (!envelopeContent || typeof envelopeContent !== 'string') {
          res.status(400).json({ error: 'Выберите зашифрованный файл резервной копии (.enc.json).' });
          return;
        }
        const result = restoreEncryptedBackupFromEnvelope(
          db,
          envelopeContent,
          filename || 'uploaded_backup.enc.json',
          req.user!.id,
          req.user!.phone || req.user!.email
        );
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Ошибка восстановления из загруженного файла.',
        });
      }
    }
  );

  router.post(
    '/security/backups/:id/restore',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = restoreEncryptedBackup(
          db,
          req.params.id,
          req.user!.id,
          req.user!.phone || req.user!.email
        );
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Ошибка восстановления из резервной копии.',
        });
      }
    }
  );

  router.get(
    '/security/backups/:id/download',
    requireAuth,
    requireRoles(['owner']),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const envFile = getBackupEnvelopeFile(db, req.params.id);
        recordAudit(db, {
          actorUserId: req.user!.id,
          actorEmail: req.user!.phone || req.user!.email,
          action: 'BACKUP_DOWNLOADED',
          entityType: 'backup',
          entityId: req.params.id,
          summary: `Скачан зашифрованный файл резервной копии ${envFile.filename} (AES-256-GCM).`,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${envFile.filename}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(envFile.content);
      } catch (err) {
        res.status(404).json({
          error: err instanceof Error ? err.message : 'Файл резервной копии не найден.',
        });
      }
    }
  );

  return router;
}

function checkAndMarkContractCompleted(db: DatabaseSync, contractId: string, nowIso: string): void {
  const cRow = db
    .prepare('SELECT current_schedule_version, status FROM contracts WHERE id = ?')
    .get(contractId) as { current_schedule_version: number; status: string } | undefined;
  if (!cRow || (cRow.status !== 'active' && cRow.status !== 'restructured')) return;

  const unpaidRow = db
    .prepare(
      `
      SELECT COALESCE(SUM(planned_kopecks - paid_kopecks), 0) as rem
      FROM schedule_items
      WHERE contract_id = ? AND schedule_version = ?
    `
    )
    .get(contractId, cRow.current_schedule_version) as { rem: number };

  if (unpaidRow.rem === 0) {
    db.prepare("UPDATE contracts SET status = 'completed', closed_at = ? WHERE id = ?").run(
      nowIso,
      contractId
    );
  }
}
