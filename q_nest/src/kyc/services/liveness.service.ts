import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { PythonApiService } from '../integrations/python-api.service';

@Injectable()
export class LivenessService {
  private readonly logger = new Logger(LivenessService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private pythonApi: PythonApiService,
  ) {}

  async verifyLiveness(
    kycId: string,
    file: Express.Multer.File,
  ): Promise<{ liveness_result: string; liveness_confidence: number }> {
    // Save file to storage
    const filePath = await this.storage.saveFile(file, 'kyc/selfies');

    // Verify liveness
    const livenessResult = await this.pythonApi.verifyLiveness(file.buffer, file.originalname);

    // Update face match record with liveness data
    await this.prisma.kyc_face_matches.updateMany({
      where: { kyc_id: kycId },
      data: {
        liveness_result: livenessResult.liveness,
        liveness_confidence: livenessResult.confidence,
        quality_score: livenessResult.quality_score || null,
        spoof_type: livenessResult.spoof_type || null,
      },
    });

    // Update verification record
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        liveness_result: livenessResult.liveness,
        liveness_confidence: livenessResult.confidence,
      },
    });

    return {
      liveness_result: livenessResult.liveness,
      liveness_confidence: livenessResult.confidence,
    };
  }
}

