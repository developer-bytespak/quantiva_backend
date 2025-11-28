import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly authTagLength = 16; // 128 bits
  private readonly encryptionKey: Buffer;

  constructor(private configService: ConfigService) {
    // Try to get from ConfigService first, then fallback to process.env
    const key = this.configService.get<string>('ENCRYPTION_KEY') || process.env.ENCRYPTION_KEY;
    if (!key) {
      this.logger.error('ENCRYPTION_KEY is not set in environment variables');
      throw new Error('ENCRYPTION_KEY is required for encryption service');
    }

    // Decode base64 key or use directly if it's already a hex string
    try {
      this.encryptionKey = Buffer.from(key, 'base64');
      if (this.encryptionKey.length !== this.keyLength) {
        throw new Error(`ENCRYPTION_KEY must be ${this.keyLength} bytes when base64 decoded`);
      }
    } catch (error) {
      this.logger.error('Failed to decode ENCRYPTION_KEY from base64', error);
      throw new Error('ENCRYPTION_KEY must be a valid base64-encoded 32-byte key');
    }

    this.logger.log('Encryption service initialized successfully');
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM
   * @param plaintext - The string to encrypt
   * @returns Base64-encoded string containing IV, authTag, and ciphertext
   */
  encryptApiKey(plaintext: string): string {
    if (!plaintext) {
      throw new Error('Plaintext cannot be empty');
    }

    try {
      // Generate a random IV for each encryption
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);

      // Encrypt the plaintext
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      // Get the authentication tag
      const authTag = cipher.getAuthTag();

      // Combine IV, authTag, and encrypted data
      const combined = Buffer.concat([iv, authTag, encrypted]);

      // Return as base64 string
      return combined.toString('base64');
    } catch (error) {
      this.logger.error('Encryption failed', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypts an encrypted string using AES-256-GCM
   * @param encrypted - Base64-encoded string containing IV, authTag, and ciphertext
   * @returns The decrypted plaintext string
   */
  decryptApiKey(encrypted: string): string {
    if (!encrypted) {
      throw new Error('Encrypted data cannot be empty');
    }

    try {
      // Decode from base64
      const combined = Buffer.from(encrypted, 'base64');

      // Extract IV, authTag, and ciphertext
      const iv = combined.slice(0, this.ivLength);
      const authTag = combined.slice(this.ivLength, this.ivLength + this.authTagLength);
      const ciphertext = combined.slice(this.ivLength + this.authTagLength);

      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      this.logger.error('Decryption failed', error);
      throw new Error('Failed to decrypt data - invalid or corrupted data');
    }
  }
}

