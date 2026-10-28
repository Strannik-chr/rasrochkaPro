import crypto from 'node:crypto';
import { getDb, withTransaction } from '../src/server/db/database';
import { hashPassword, normalizeRussianPhone } from '../src/server/security/crypto';
import { recordAudit } from '../src/server/services/reconciliationAndBackup';

function parseArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const rawPhone = parseArg('--phone') || process.env.ADMIN_BOOTSTRAP_PHONE;
const password = parseArg('--password') || process.env.ADMIN_BOOTSTRAP_PASSWORD;
const fullName = parseArg('--name') || process.env.ADMIN_BOOTSTRAP_NAME || 'Главный администратор';

if (!rawPhone || !password) {
  console.error(
    'Использование: npm run create-admin -- --phone="+79285550101" --password="StrongPassword!2026" [--name="Имя"]'
  );
  process.exit(1);
}

const normalizedPhone = normalizeRussianPhone(rawPhone);
if (!normalizedPhone) {
  console.error('Ошибка: некорректный российский номер телефона. Ожидается формат +7XXXXXXXXXX.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Ошибка: пароль должен содержать не менее 8 символов.');
  process.exit(1);
}

const db = getDb();
const nowIso = new Date().toISOString();

withTransaction(db, () => {
  const existing = db
    .prepare('SELECT id FROM users WHERE phone = ?')
    .get(normalizedPhone) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE users
       SET full_name = ?, password_hash = ?, role = 'owner', status = 'active',
           must_change_password = 0, password_changed_at = ?, failed_login_attempts = 0, locked_until = NULL
       WHERE id = ?`
    ).run(fullName.trim(), hashPassword(password), nowIso, existing.id);

    recordAudit(db, {
      actorUserId: existing.id,
      actorEmail: normalizedPhone,
      action: 'CLI_ADMIN_BOOTSTRAPPED',
      entityType: 'user',
      entityId: existing.id,
      summary: `Обновлена учётная запись администратора ${normalizedPhone} через защищённую CLI-процедуру.`,
    });
    console.log(`[OK] Администратор ${normalizedPhone} обновлён и активирован (ID: ${existing.id}).`);
  } else {
    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const syntheticEmail = `${normalizedPhone.replace('+', '')}@phone.rassrochka.local`;
    db.prepare(
      `INSERT INTO users (
        id, email, full_name, phone, password_hash, role, status,
        must_change_password, password_changed_at, mfa_enabled, approved_by, approved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'owner', 'active', 0, ?, 0, ?, ?, ?)`
    ).run(
      userId,
      syntheticEmail,
      fullName.trim(),
      normalizedPhone,
      hashPassword(password),
      nowIso,
      userId,
      nowIso,
      nowIso
    );

    recordAudit(db, {
      actorUserId: userId,
      actorEmail: normalizedPhone,
      action: 'CLI_ADMIN_BOOTSTRAPPED',
      entityType: 'user',
      entityId: userId,
      summary: `Создан первый администратор ${normalizedPhone} через защищённую CLI-процедуру.`,
    });
    console.log(`[OK] Создан администратор ${normalizedPhone} (ID: ${userId}).`);
  }
});
