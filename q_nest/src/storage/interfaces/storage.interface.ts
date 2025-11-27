import { File } from 'multer';

export interface IStorageService {
  saveFile(file: File, subfolder?: string): Promise<string>;
  getFileUrl(filePath: string): string;
  deleteFile(filePath: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
}

