import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IStorageService } from './interfaces/storage.interface';

@Injectable()
export class StorageService implements IStorageService {
  private readonly storageRoot: string;

  constructor(private configService: ConfigService) {
    this.storageRoot = this.configService.get<string>('STORAGE_ROOT', './storage');
    this.ensureStorageDirectory();
  }

  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.storageRoot, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore error
    }
  }

  async saveFile(file: Express.Multer.File, subfolder?: string): Promise<string> {
    // Validate file buffer
    if (!file.buffer || file.buffer.length === 0) {
      throw new Error(`File buffer is empty for file: ${file.originalname}`);
    }

    const folder = subfolder ? path.join(this.storageRoot, subfolder) : this.storageRoot;
    await fs.mkdir(folder, { recursive: true });

    const fileExtension = path.extname(file.originalname);
    const fileName = `${uuidv4()}${fileExtension}`;
    const filePath = path.join(folder, fileName);

    // Write file and verify it was written
    await fs.writeFile(filePath, file.buffer);
    
    // Verify file was written correctly
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      throw new Error(`File was written but is empty: ${filePath}`);
    }
    if (stats.size !== file.buffer.length) {
      throw new Error(
        `File size mismatch: expected ${file.buffer.length} bytes, got ${stats.size} bytes`,
      );
    }

    // Return relative path using forward slashes for consistency (works on all platforms)
    const relativePath = subfolder ? `${subfolder.replace(/\\/g, '/')}/${fileName}` : fileName;
    return relativePath;
  }

  getFileUrl(filePath: string): string {
    // For local storage, return relative path
    // In production with S3, this would return the S3 URL
    return `/storage/${filePath}`;
  }

  async deleteFile(filePath: string): Promise<void> {
    const fullPath = path.join(this.storageRoot, filePath);
    try {
      await fs.unlink(fullPath);
    } catch (error) {
      // File might not exist, ignore error
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.storageRoot, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

