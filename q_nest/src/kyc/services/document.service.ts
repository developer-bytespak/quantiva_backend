import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { PythonApiService } from '../integrations/python-api.service';
import * as fs from 'fs/promises';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private pythonApi: PythonApiService,
  ) {}

  async uploadDocument(
    kycId: string,
    file: Express.Multer.File,
    documentType?: string,
  ): Promise<string> {
    const startTime = Date.now();
    this.logger.log(`[DOCUMENT_SERVICE_UPLOAD_START] Starting document service upload for KYC ${kycId}`);
    
    // Save file to storage
    const saveStartTime = Date.now();
    const filePath = await this.storage.saveFile(file, 'kyc/documents');
    const saveTime = Date.now() - saveStartTime;
    this.logger.log(`[DOCUMENT_SERVICE_UPLOAD_STEP_1] File saved to storage in ${saveTime}ms: ${filePath}`);

    // Create document record
    const dbStartTime = Date.now();
    const document = await this.prisma.kyc_documents.create({
      data: {
        kyc_id: kycId,
        storage_url: filePath,
        document_type: documentType || null,
      },
    });
    const dbTime = Date.now() - dbStartTime;
    this.logger.log(`[DOCUMENT_SERVICE_UPLOAD_STEP_2] Database record created in ${dbTime}ms`);

    // Start OCR and authenticity checks asynchronously
    const ocrStartTime = Date.now();
    this.performOCR(document.document_id, filePath, file.buffer, file.originalname).catch(
      (error) => {
        const ocrTime = Date.now() - ocrStartTime;
        this.logger.error(`[DOCUMENT_SERVICE_OCR_FAILED] OCR processing failed for document ${document.document_id} after ${ocrTime}ms`, {
          filePath,
          errorMessage: error?.message, 
          errorCode: error?.code,
        });
      },
    ).then(() => {
      const ocrTime = Date.now() - ocrStartTime;
      this.logger.log(`[DOCUMENT_SERVICE_OCR_COMPLETE] OCR processing completed in ${ocrTime}ms for document ${document.document_id}`);
    });

    // Check document authenticity
    const authStartTime = Date.now();
    this.checkAuthenticity(document.document_id, filePath, file.buffer, file.originalname).catch(
      (error) => {
        const authTime = Date.now() - authStartTime;
        this.logger.error(`[DOCUMENT_SERVICE_AUTH_FAILED] Authenticity check failed for document ${document.document_id} after ${authTime}ms`, {
          filePath,
          errorMessage: error?.message,
          errorCode: error?.code,
        });
      },
    ).then(() => {
      const authTime = Date.now() - authStartTime;
      this.logger.log(`[DOCUMENT_SERVICE_AUTH_COMPLETE] Authenticity check completed in ${authTime}ms for document ${document.document_id}`);
    });

    const totalTime = Date.now() - startTime;
    this.logger.log(`[DOCUMENT_SERVICE_UPLOAD_COMPLETE] Document upload completed in ${totalTime}ms (save: ${saveTime}ms, db: ${dbTime}ms). OCR and authenticity running in background.`);

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
      this.logger.debug(`OCR completed successfully for document ${documentId}`);
    } catch (error) {
      this.logger.warn(`OCR processing skipped for document ${documentId}: ${error?.message || 'Unknown error'}. Document still usable for face matching.`);
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
      this.logger.debug(`Authenticity check completed for document ${documentId}`);
    } catch (error) {
      this.logger.warn(`Authenticity check skipped for document ${documentId}: ${error?.message || 'Unknown error'}. Document still usable for face matching.`);
    }
  }

  async getDocument(kycId: string) {
    return this.prisma.kyc_documents.findFirst({
      where: { kyc_id: kycId },
      orderBy: { created_at: 'desc' },
    });
  }
}

