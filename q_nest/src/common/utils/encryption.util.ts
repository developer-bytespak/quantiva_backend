import * as crypto from 'crypto';

/**
 * Encryption utility using AES-256-GCM
 * Uses ENCRYPTION_KEY from .env
 */
export class EncryptionUtil {
  /**
   * Encrypt a plain text string
   * Returns: iv:authTag:encryptedData (all in hex)
   */
  static encrypt(plainText: string, encryptionKey: string): string {
    const key = Buffer.from(encryptionKey, 'base64');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encryptedData (all in hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt an encrypted string
   * Expects format: iv:authTag:encryptedData (all in hex)
   */
  static decrypt(encryptedString: string, encryptionKey: string): string {
    const key = Buffer.from(encryptionKey, 'base64');
    const parts = encryptedString.split(':');

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
