import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { PythonApiService } from '../integrations/python-api.service';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinary: CloudinaryService,
    private pythonApi: PythonApiService,
  ) {}

  async uploadDocument(
    kycId: string,
    file: Express.Multer.File,
    documentType?: string,
  ): Promise<string> {
    this.logger.log(`Uploading document for KYC: ${kycId}`);
    
    // Upload file to Cloudinary instead of local storage
    const uploadResult = await this.cloudinary.uploadFile(file, 'quantiva/kyc/documents');
    
    this.logger.log(`Document uploaded to Cloudinary: ${uploadResult.secureUrl}`);

    // Create document record with Cloudinary URL
    const document = await this.prisma.kyc_documents.create({
      data: {
        kyc_id: kycId,
        storage_url: uploadResult.secureUrl, // Store the full Cloudinary URL
        document_type: documentType || null,
      },
    });

    // Check document authenticity (async, non-blocking)
    this.checkAuthenticity(document.document_id, uploadResult.secureUrl, file.buffer, file.originalname).catch(
      (error) => {
        this.logger.error('Authenticity check failed', error);
      },
    );

    return document.document_id;
  }

  private async performOCR(
    documentId: string,
    filePath: string,
    buffer: Buffer,
    filename: string,
  ): Promise<void> {
    try {
      const ocrResult = await this.pythonApi.performOCR(buffer, filename);

      await this.prisma.kyc_documents.update({
        where: { document_id: documentId },
        data: {
          ocr_name: ocrResult.name || null,
          ocr_dob: ocrResult.dob ? new Date(ocrResult.dob) : null,
          ocr_confidence: ocrResult.confidence || null,
          mrz_text: ocrResult.mrz_text || null,
        },
      });
    } catch (error) {
      this.logger.error(`OCR failed for document ${documentId}`, error);
    }
  }

  private async checkAuthenticity(
    documentId: string,
    filePath: string,
    buffer: Buffer,
    filename: string,
  ): Promise<void> {
    try {
      const authenticityResult = await this.pythonApi.checkDocumentAuthenticity(buffer, filename);

      await this.prisma.kyc_documents.update({
        where: { document_id: documentId },
        data: {
          authenticity_flags: authenticityResult.flags as any,
        },
      });

      // Update verification with authenticity score
      const document = await this.prisma.kyc_documents.findUnique({
        where: { document_id: documentId },
        select: { kyc_id: true },
      });

      if (document) {
        await this.prisma.kyc_verifications.update({
          where: { kyc_id: document.kyc_id },
          data: {
            doc_authenticity_score: authenticityResult.authenticity_score,
          },
        });
      }
    } catch (error) {
      this.logger.error(`Authenticity check failed for document ${documentId}`, error);
    }
  }

  async getDocument(kycId: string) {
    return this.prisma.kyc_documents.findFirst({
      where: { kyc_id: kycId },
      orderBy: { created_at: 'desc' },
    });
  }
}

