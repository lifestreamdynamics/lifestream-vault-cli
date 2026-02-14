import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CliConfig } from '../config.js';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const ENCRYPTED_FILE = path.join(CONFIG_DIR, 'credentials.enc');

const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32; // AES-256
const AUTH_TAG_LENGTH = 16;

export interface EncryptedCredentials {
  version: 1;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface EncryptedConfigBackend {
  isAvailable(): boolean;
  getCredentials(passphrase: string): Partial<CliConfig> | null;
  saveCredentials(config: Partial<CliConfig>, passphrase: string): void;
  clearCredentials(): void;
  hasCredentials(): boolean;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(plaintext: string, passphrase: string): EncryptedCredentials {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decrypt(data: EncryptedCredentials, passphrase: string): string {
  const salt = Buffer.from(data.salt, 'hex');
  const iv = Buffer.from(data.iv, 'hex');
  const authTag = Buffer.from(data.authTag, 'hex');
  const ciphertext = Buffer.from(data.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function createEncryptedConfigBackend(): EncryptedConfigBackend {
  return {
    isAvailable(): boolean {
      return true; // Node.js crypto is always available
    },

    getCredentials(passphrase: string): Partial<CliConfig> | null {
      if (!fs.existsSync(ENCRYPTED_FILE)) return null;

      try {
        const raw = fs.readFileSync(ENCRYPTED_FILE, 'utf-8');
        const data: EncryptedCredentials = JSON.parse(raw);

        if (data.version !== 1) return null;

        const plaintext = decrypt(data, passphrase);
        return JSON.parse(plaintext) as Partial<CliConfig>;
      } catch {
        // Wrong passphrase or corrupt file
        return null;
      }
    },

    saveCredentials(config: Partial<CliConfig>, passphrase: string): void {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      }

      // Merge with existing credentials if possible
      let existing: Partial<CliConfig> = {};
      if (fs.existsSync(ENCRYPTED_FILE)) {
        try {
          const raw = fs.readFileSync(ENCRYPTED_FILE, 'utf-8');
          const data: EncryptedCredentials = JSON.parse(raw);
          const plaintext = decrypt(data, passphrase);
          existing = JSON.parse(plaintext);
        } catch {
          // Can't decrypt existing — overwrite
        }
      }

      const merged = { ...existing, ...config };
      const encrypted = encrypt(JSON.stringify(merged), passphrase);
      const tmpFile = ENCRYPTED_FILE + '.tmp.' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmpFile, JSON.stringify(encrypted, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmpFile, ENCRYPTED_FILE);
    },

    clearCredentials(): void {
      if (fs.existsSync(ENCRYPTED_FILE)) {
        fs.unlinkSync(ENCRYPTED_FILE);
      }
    },

    hasCredentials(): boolean {
      return fs.existsSync(ENCRYPTED_FILE);
    },
  };
}

// Export for testing
export { ENCRYPTED_FILE, CONFIG_DIR, PBKDF2_ITERATIONS };
