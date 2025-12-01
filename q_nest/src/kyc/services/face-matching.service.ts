import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { PythonApiService } from '../integrations/python-api.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class FaceMatchingService {
  private readonly logger = new Logger(FaceMatchingService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private pythonApi: PythonApiService,
    private configService: ConfigService,
  ) {}

  async matchFaces(
    kycId: string,
    selfieFile: Express.Multer.File,
  ): Promise<{ similarity: number; is_match: boolean }> {
    // Get ID document
    const document = await this.prisma.kyc_documents.findFirst({
      where: { kyc_id: kycId },
      orderBy: { created_at: 'desc' },
    });

    if (!document) {
      this.logger.error(`No document found for KYC verification: ${kycId}`);
      throw new Error('No document found for KYC verification');
    }

    if (!document.storage_url) {
      this.logger.error(`Document ${document.document_id} has no storage_url`);
      throw new Error('Document storage URL is missing');
    }

    this.logger.debug(
      `Matching faces for KYC ${kycId}, document: ${document.document_id}, storage: ${document.storage_url}`,
    );

    // Read ID photo from storage (assuming document contains photo)
    // For now, we'll use the document image itself
    // In production, you might extract the photo from the document
    const idPhotoBuffer = await this.getDocumentImageBuffer(document.storage_url);

    if (!idPhotoBuffer || idPhotoBuffer.length === 0) {
      this.logger.error(`ID photo buffer is empty for document: ${document.storage_url}`);
      throw new Error('Failed to read ID photo from storage');
    }

    this.logger.debug(
      `ID photo buffer size: ${idPhotoBuffer.length} bytes, selfie buffer size: ${selfieFile.buffer.length} bytes`,
    );

    // Perform face matching
    let matchResult;
    try {
      matchResult = await this.pythonApi.matchFaces(
        idPhotoBuffer,
        selfieFile.buffer,
        document.storage_url,
        selfieFile.originalname,
      );
      
      this.logger.debug(
        `Face matching result: similarity=${matchResult.similarity}, is_match=${matchResult.is_match}`,
      );
      
      // Check if faces were detected
      if (matchResult.similarity === 0 && !matchResult.is_match) {
        this.logger.warn('Face matching returned zero similarity - faces may not have been detected');
      }
    } catch (error: any) {
      this.logger.error('Face matching API call failed', {
        error: error?.message,
        stack: error?.stack,
      });
      throw new Error(
        `Face matching failed: ${error?.message || 'Unknown error'}. Please ensure both images contain clear faces.`,
      );
    }

    // Save selfie
    const selfiePath = await this.storage.saveFile(selfieFile, 'kyc/selfies');

    // Check if face match record exists
    const existingMatch = await this.prisma.kyc_face_matches.findFirst({
      where: { kyc_id: kycId },
    });

    if (existingMatch) {
      // Update existing record
      await this.prisma.kyc_face_matches.update({
        where: { match_id: existingMatch.match_id },
        data: {
          photo_url: selfiePath,
          similarity: matchResult.similarity,
          is_match: matchResult.is_match,
        },
      });
    } else {
      // Create new record
      await this.prisma.kyc_face_matches.create({
        data: {
          kyc_id: kycId,
          photo_url: selfiePath,
          similarity: matchResult.similarity,
          is_match: matchResult.is_match,
        },
      });
    }

    // Update verification record
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        face_match_score: matchResult.similarity,
      },
    });

    return {
      similarity: matchResult.similarity,
      is_match: matchResult.is_match,
    };
  }

  private async getDocumentImageBuffer(storagePath: string): Promise<Buffer> {
    // Get storage root from config (same as StorageService uses)
    const storageRoot = this.configService.get<string>('STORAGE_ROOT', './storage');
    
    // Normalize path separators (handle both / and \ for cross-platform compatibility)
    const normalizedPath = storagePath.replace(/\\/g, '/');
    const fullPath = path.join(storageRoot, normalizedPath);
    
    this.logger.debug(`Reading document from: ${fullPath}`);
    
    try {
      // Check if file exists
      await fs.access(fullPath);
      
      // Read file
      const buffer = await fs.readFile(fullPath);
      
      if (!buffer || buffer.length === 0) {
        this.logger.error(`File exists but is empty: ${fullPath}`);
        throw new Error(`Document file is empty: ${storagePath}`);
      }
      
      this.logger.debug(`Successfully read document, size: ${buffer.length} bytes`);
      return buffer;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.error(`Document file not found: ${fullPath}`);
        throw new Error(`Document file not found: ${storagePath}`);
      }
      this.logger.error(`Failed to read document file: ${fullPath}`, error);
      throw new Error(`Failed to read document: ${error.message}`);
    }
  }
}

