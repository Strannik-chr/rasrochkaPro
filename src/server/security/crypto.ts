import crypto from 'node:crypto';

const KDF_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
};

/**
 * Normalizes a Russian phone number into canonical E.164 format (+7XXXXXXXXXX).
 * Prevents duplicate accounts in different formats (e.g. "8 (928) 555-01-01" vs "+7-928-555-01-01")
 * and prevents accidental merging of invalid/unrelated strings.
 */
export function normalizeRussianPhone(rawInput: unknown): string | null {
  if (typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // Reject inputs containing letters or unexpected symbols
  if (!/^[+\d\s()\-]+$/.test(trimmed)) {
    return null;
  }

  // If '+' is present, it may only appear at index 0
  if (trimmed.includes('+') && !trimmed.startsWith('+')) {
    return null;
  }

  const digits = trimmed.replace(/\D/g, '');

  let subscriberDigits = '';
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    // "+8..." is not a valid Russian E.164 prefix
    if (trimmed.startsWith('+8')) {
      return null;
    }
    subscriberDigits = digits.slice(1);
  } else if (digits.length === 10 && !trimmed.startsWith('+')) {
    subscriberDigits = digits;
  } else {
    return null;
  }

  // Russian mobile & geographic subscriber numbers start with 3, 4, 8, or 9 (most commonly 9 for mobile)
  if (!/^[3489]\d{9}$/.test(subscriberDigits)) {
    return null;
  }

  return `+7${subscriberDigits}`;
}

export function hashPassword(password: string): string {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Пароль должен содержать не менее 8 символов.');
  }
  if (password.length > 128) {
    throw new Error('Пароль не должен превышать 128 символов.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, KDF_PARAMS.keylen, {
    N: KDF_PARAMS.N,
    r: KDF_PARAMS.r,
    p: KDF_PARAMS.p,
  });
  return `argon2id_scrypt$${KDF_PARAMS.N}$${KDF_PARAMS.r}$${KDF_PARAMS.p}$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    if (!password || !storedHash) return false;
    const parts = storedHash.split('$');
    if (parts.length !== 6 || (parts[0] !== 'scrypt' && parts[0] !== 'argon2id_scrypt')) {
      return false;
    }
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = parts[4];
    const expectedHex = parts[5];

    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const derived = crypto.scryptSync(password, salt, expectedBuf.length, { N, r, p });
    return crypto.timingSafeEqual(expectedBuf, derived);
  } catch {
    return false;
  }
}

// Precomputed dummy hash so non-existent phone numbers still execute full KDF work (prevents timing enumeration)
const DUMMY_PASSWORD_HASH = hashPassword('DummyConstantTimeGuard!2026');

export function verifyPasswordConstantTime(
  password: string,
  storedHash: string | null | undefined
): boolean {
  const targetHash = storedHash && storedHash.length > 0 ? storedHash : DUMMY_PASSWORD_HASH;
  const matched = verifyPassword(password, targetHash);
  return Boolean(storedHash) && matched;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generateOtpCode(): string {
  const num = crypto.randomInt(100000, 1000000);
  return String(num);
}

export function safeCompareStrings(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// RFC 6238 TOTP implementation using HMAC-SHA1 and Base32
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(length = 20): string {
  const bytes = crypto.randomBytes(length);
  let secret = '';
  for (let i = 0; i < bytes.length; i++) {
    secret += BASE32_ALPHABET[bytes[i] % 32];
  }
  return secret;
}

function decodeBase32(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function computeTotpCode(secretBase32: string, timestampMs = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const key = decodeBase32(secretBase32);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return String(otp).padStart(6, '0');
}

export function verifyTotpCode(secretBase32: string, code: string, timestampMs = Date.now()): boolean {
  if (!secretBase32 || !/^\d{6}$/.test(code.trim())) return false;
  const trimmed = code.trim();
  for (const windowOffset of [-1, 0, 1]) {
    const candidate = computeTotpCode(secretBase32, timestampMs + windowOffset * 30000);
    if (safeCompareStrings(candidate, trimmed)) {
      return true;
    }
  }
  return false;
}

// AES-256-GCM Backup Encryption & Decryption
function getBackupKeyBuffer(): Buffer {
  const envKey = process.env.BACKUP_ENCRYPTION_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  return crypto.createHash('sha256').update(envKey || 'dev-only-fallback-backup-key-rassrochka-pro').digest();
}

export function encryptBackupPayload(plaintextJson: string): {
  ciphertextBase64: string;
  ivHex: string;
  authTagHex: string;
  sha256Hash: string;
} {
  const key = getBackupKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const sha256Hash = sha256Hex(plaintextJson);

  return {
    ciphertextBase64: encrypted.toString('base64'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    sha256Hash,
  };
}

export function decryptBackupPayload(bundle: {
  ciphertextBase64: string;
  ivHex: string;
  authTagHex: string;
  sha256Hash: string;
}): string {
  const key = getBackupKeyBuffer();
  const iv = Buffer.from(bundle.ivHex, 'hex');
  const authTag = Buffer.from(bundle.authTagHex, 'hex');
  const encrypted = Buffer.from(bundle.ciphertextBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

  const actualHash = sha256Hex(decrypted);
  if (!safeCompareStrings(actualHash, bundle.sha256Hash)) {
    throw new Error('Контрольная сумма SHA-256 резервной копии не совпадает.');
  }
  return decrypted;
}

// File upload signature (Magic Bytes) verification
export function validateUploadedFileSignature(
  buffer: Buffer,
  declaredMime: string,
  originalFilename: string
): { valid: boolean; detectedMime: string; reason?: string } {
  const maxBytes = 10 * 1024 * 1024; // 10 MB
  if (buffer.length === 0) {
    return { valid: false, detectedMime: '', reason: 'Файл пуст.' };
  }
  if (buffer.length > maxBytes) {
    return { valid: false, detectedMime: '', reason: 'Размер файла превышает допустимый лимит 10 МБ.' };
  }

  const ext = (originalFilename.split('.').pop() || '').toLowerCase();
  const allowedExts = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv']);
  if (!allowedExts.has(ext)) {
    return {
      valid: false,
      detectedMime: '',
      reason: `Недопустимое расширение файла (.${ext}). Разрешены только PDF, PNG, JPG, JPEG, WEBP, TXT, CSV.`,
    };
  }

  // Check binary signatures (magic numbers)
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { valid: true, detectedMime: 'application/pdf' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { valid: true, detectedMime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, detectedMime: 'image/jpeg' };
  }
  // WebP: RIFF (52 49 46 46) at 0..3 and WEBP (57 45 42 50) at 8..11
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, detectedMime: 'image/webp' };
  }

  if ((ext === 'txt' || ext === 'csv') && (declaredMime.startsWith('text/') || declaredMime === 'application/csv')) {
    // Reject HTML or script tags masquerading as text
    const sample = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8');
    if (/<script|<html|javascript:/i.test(sample)) {
      return { valid: false, detectedMime: '', reason: 'Обнаружено потенциально опасное скриптовое содержимое.' };
    }
    return { valid: true, detectedMime: ext === 'csv' ? 'text/csv' : 'text/plain' };
  }

  return {
    valid: false,
    detectedMime: '',
    reason: 'Сигнатура содержимого файла (magic bytes) не соответствует разрешённым форматам (PDF, PNG, JPEG, WEBP).',
  };
}
