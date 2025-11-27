import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { PythonApiService } from '../integrations/python-api.service';

@Injectable()
export class FaceMatchingService {
  private readonly logger = new Logger(FaceMatchingService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private pythonApi: PythonApiService,
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
      throw new Error('No document found for KYC verification');
    }

    // Read ID photo from storage (assuming document contains photo)
    // For now, we'll use the document image itself
    // In production, you might extract the photo from the document
    const idPhotoBuffer = await this.getDocumentImageBuffer(document.storage_url);

    // Perform face matching
    const matchResult = await this.pythonApi.matchFaces(
      idPhotoBuffer,
      selfieFile.buffer,
      document.storage_url,
      selfieFile.originalname,
    );

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
    const fs = require('fs/promises');
    const path = require('path');
    // This is a simplified version - in production, you'd properly read from storage
    const fullPath = path.join('./storage', storagePath);
    return fs.readFile(fullPath);
  }
}

