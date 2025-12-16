import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class TestnetEncryptionService {
  private readonly logger = new Logger(TestnetEncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly saltLength = 16;
  private readonly tagLength = 16;
  private readonly iterations = 100000;

  /**
   * Encrypts API key and secret for testnet connections
   */
  public encrypt(text: string, masterKey: string): string {
    try {
      // Derive a key from the master key
      const salt = crypto.randomBytes(this.saltLength);
      const key = crypto.pbkdf2Sync(masterKey, salt, this.iterations, 32, 'sha256');

      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);

      let encrypted = cipher.update(text, 'utf-8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      // Combine salt, iv, authTag, and encrypted data
      const combined = salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
      return Buffer.from(combined).toString('base64');
    } catch (error) {
      this.logger.error(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Decrypts API key and secret for testnet connections
   */
  public decrypt(encryptedText: string, masterKey: string): string {
    try {
      const combined = Buffer.from(encryptedText, 'base64').toString('utf-8');
      const [saltHex, ivHex, authTagHex, encrypted] = combined.split(':');

      const salt = Buffer.from(saltHex, 'hex');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      // Derive the key using the same method as encryption
      const key = crypto.pbkdf2Sync(masterKey, salt, this.iterations, 32, 'sha256');

      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');

      return decrypted;
    } catch (error) {
      this.logger.error(`Decryption failed: ${error.message}`);
      throw error;
    }
  }
}
