import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { PythonApiService } from '../integrations/python-api.service';

@Injectable()
export class FaceMatchingService {
  private readonly logger = new Logger(FaceMatchingService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinary: CloudinaryService,
    private pythonApi: PythonApiService,
    private configService: ConfigService,
  ) {}

  async matchFaces(
    kycId: string,
    selfieFile: Express.Multer.File,
  ): Promise<{ similarity: number; is_match: boolean }> {
    const totalStart = Date.now();
    this.logger.log('======================================================================');
    this.logger.log(`🚀 [NEST-KYC] matchFaces() called for KYC: ${kycId}`);
    this.logger.log('======================================================================');
    
    // Step 1: Get ID document from DB
    this.logger.log('📋 [NEST-KYC] Step 1: Fetching document from database...');
    const step1Start = Date.now();
    const document = await this.prisma.kyc_documents.findFirst({
      where: { kyc_id: kycId },
      orderBy: { created_at: 'desc' },
    });
    this.logger.log(`   DB query completed in ${Date.now() - step1Start}ms`);

    if (!document) {
      this.logger.error(`No document found for KYC verification: ${kycId}`);
      throw new Error('No document found for KYC verification');
    }

    if (!document.storage_url) {
      this.logger.error(`Document ${document.document_id} has no storage_url`);
      throw new Error('Document storage URL is missing');
    }

    this.logger.log(`   Document found: ${document.document_id}, storage: ${document.storage_url}`);

    // Step 2: Fetch ID photo from Cloudinary URL
    this.logger.log('📷 [NEST-KYC] Step 2: Fetching ID photo from Cloudinary...');
    const step2Start = Date.now();
    const idPhotoBuffer = await this.getDocumentImageBuffer(document.storage_url);
    this.logger.log(`   Cloudinary fetch completed in ${Date.now() - step2Start}ms`);

    if (!idPhotoBuffer || idPhotoBuffer.length === 0) {
      this.logger.error(`ID photo buffer is empty for document: ${document.storage_url}`);
      throw new Error('Failed to fetch ID photo from Cloudinary');
    }

    this.logger.log(
      `   ID photo: ${idPhotoBuffer.length} bytes, Selfie: ${selfieFile.buffer.length} bytes`,
    );

    // Step 3: Call Python API for face matching
    this.logger.log('🐍 [NEST-KYC] Step 3: Calling Python API for face matching...');
    const step3Start = Date.now();
    let matchResult;
    try {
      matchResult = await this.pythonApi.matchFaces(
        idPhotoBuffer,
        selfieFile.buffer,
        document.storage_url,
        selfieFile.originalname,
      );
      
      const apiTime = Date.now() - step3Start;
      this.logger.log(`   ✅ Python API responded in ${apiTime}ms (${(apiTime/1000).toFixed(2)}s)`);
      this.logger.log(
        `   Result: similarity=${matchResult.similarity}, is_match=${matchResult.is_match}`,
      );
      
      // Check if faces were detected
      if (matchResult.similarity === 0 && !matchResult.is_match) {
        this.logger.warn('   ⚠️ Zero similarity - faces may not have been detected');
      }
    } catch (error: any) {
      const apiTime = Date.now() - step3Start;
      this.logger.error(`   ❌ Python API FAILED after ${apiTime}ms: ${error?.message}`);
      throw new Error(
        `Face matching failed: ${error?.message || 'Unknown error'}. Please ensure both images contain clear faces.`,
      );
    }

    // Step 4: Upload selfie to Cloudinary
    this.logger.log('💾 [NEST-KYC] Step 4: Uploading selfie to Cloudinary...');
    const step4Start = Date.now();
    const selfieUpload = await this.cloudinary.uploadFile(selfieFile, 'quantiva/kyc/selfies');
    this.logger.log(`   Selfie uploaded in ${Date.now() - step4Start}ms: ${selfieUpload.secureUrl}`);

    // Step 5: Update database records
    this.logger.log('🗄️  [NEST-KYC] Step 5: Updating database records...');
    const step5Start = Date.now();
    
    // Check if face match record exists
    const existingMatch = await this.prisma.kyc_face_matches.findFirst({
      where: { kyc_id: kycId },
    });

    if (existingMatch) {
      // Update existing record
      await this.prisma.kyc_face_matches.update({
        where: { match_id: existingMatch.match_id },
        data: {
          photo_url: selfieUpload.secureUrl,
          similarity: matchResult.similarity,
          is_match: matchResult.is_match,
        },
      });
    } else {
      // Create new record
      await this.prisma.kyc_face_matches.create({
        data: {
          kyc_id: kycId,
          photo_url: selfieUpload.secureUrl,
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
    
    this.logger.log(`   DB updates completed in ${Date.now() - step5Start}ms`);
    
    const totalTime = Date.now() - totalStart;
    this.logger.log('======================================================================');
    this.logger.log(`✅ [NEST-KYC] matchFaces() COMPLETE`);
    this.logger.log(`   Total time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
    this.logger.log(`   Result: similarity=${matchResult.similarity}, is_match=${matchResult.is_match}`);
    this.logger.log('======================================================================');

    return {
      similarity: matchResult.similarity,
      is_match: matchResult.is_match,
    };
  }

  /**
   * Fetch document image from Cloudinary URL or local storage (for backward compatibility)
   */
  private async getDocumentImageBuffer(storageUrl: string): Promise<Buffer> {
    // Check if it's a Cloudinary URL (starts with http/https)
    if (storageUrl.startsWith('http://') || storageUrl.startsWith('https://')) {
      this.logger.debug(`Fetching document from Cloudinary: ${storageUrl}`);
      return this.cloudinary.fetchImageBuffer(storageUrl);
    }
    
    // Fallback for old local storage paths (shouldn't happen after migration)
    this.logger.warn(`Document has old local storage path: ${storageUrl}. This will fail on Render.`);
    throw new Error(`Document stored locally, not on Cloudinary. Please re-upload the document. Path: ${storageUrl}`);
  }
}

