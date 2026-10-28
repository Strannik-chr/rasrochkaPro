import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256Hex } from '../security/crypto';

export type StorageBackendMode = 'local_private' | 'cloudflare_r2_configured';

export interface StoredFileResult {
  storageBackend: StorageBackendMode;
  storedFilename: string;
  sha256Hash: string;
  sha256: string;
  sizeBytes: number;
}

export function getStorageConfig() {
  const r2AccountId = process.env.R2_ACCOUNT_ID || '';
  const r2Bucket = process.env.R2_BUCKET_NAME || '';
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const isR2Configured = Boolean(
    r2AccountId &&
      r2Bucket &&
      r2AccessKeyId &&
      r2SecretAccessKey &&
      !r2AccessKeyId.startsWith('REPLACE_')
  );

  const localUploadsDir =
    process.env.PRIVATE_STORAGE_DIR ||
    process.env.LOCAL_UPLOADS_DIR ||
    path.resolve(process.cwd(), 'uploads');

  return {
    mode: (isR2Configured ? 'cloudflare_r2_configured' : 'local_private') as StorageBackendMode,
    localUploadsDir,
    r2AccountId,
    r2Bucket,
  };
}

export const getStorageStatus = getStorageConfig;

/**
 * Ensures safe storage filename without path traversal characters.
 */
export function sanitizeStoredFilename(storedFilename: string): string {
  const base = path.basename(storedFilename).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!base || base.includes('..')) {
    throw new Error('Недопустимое внутреннее имя файла.');
  }
  return base;
}

/**
 * Persists a validated private document buffer outside the public web root with 0600 permissions.
 */
export function writePrivateDocumentBuffer(
  storedFilename: string,
  buffer: Buffer
): StoredFileResult {
  const cfg = getStorageConfig();
  const safeName = sanitizeStoredFilename(storedFilename);
  if (!fs.existsSync(cfg.localUploadsDir)) {
    fs.mkdirSync(cfg.localUploadsDir, { recursive: true, mode: 0o700 });
  }
  const fullPath = path.join(cfg.localUploadsDir, safeName);
  fs.writeFileSync(fullPath, buffer, { mode: 0o600 });
  const hash = sha256Hex(buffer);

  return {
    storageBackend: cfg.mode,
    storedFilename: safeName,
    sha256Hash: hash,
    sha256: hash,
    sizeBytes: buffer.length,
  };
}

/**
 * Reads a private document buffer and verifies its SHA-256 integrity hash before serving.
 * Falls back to legacy `content_base64` column if the file was created in an in-memory test DB.
 */
export function readPrivateDocumentBuffer(
  storedFilename: string,
  fallbackBase64: string,
  expectedSha256: string
): Buffer {
  const cfg = getStorageConfig();
  const safeName = sanitizeStoredFilename(storedFilename);
  const fullPath = path.join(cfg.localUploadsDir, safeName);

  let buffer: Buffer;
  if (fs.existsSync(fullPath)) {
    buffer = fs.readFileSync(fullPath);
  } else if (fallbackBase64) {
    buffer = Buffer.from(fallbackBase64, 'base64');
  } else {
    throw new Error('Файл документа не найден в защищённом хранилище.');
  }

  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error('Нарушена целостность файла документа (SHA-256 не совпадает).');
  }
  return buffer;
}

/**
 * Removes a private document file from disk when deleted/replaced by owner.
 */
export function removePrivateDocumentFile(storedFilename: string): void {
  try {
    const cfg = getStorageConfig();
    const safeName = sanitizeStoredFilename(storedFilename);
    const fullPath = path.join(cfg.localUploadsDir, safeName);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch {
    // ignore if already absent
  }
}
