import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudinaryService } from '../../storage/cloudinary.service';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinary: CloudinaryService,
  ) {}

  async uploadDocument(
    kycId: string,
    file: Express.Multer.File,
    documentType?: string,
    documentSide?: string,
  ): Promise<string> {
    this.logger.log(`Uploading document for KYC: ${kycId}, type: ${documentType}, side: ${documentSide || 'N/A'}`);
    
    // Check if this side already exists for this document type (replace workflow)
    if (documentSide && documentType) {
      const existingDoc = await this.prisma.kyc_documents.findFirst({
        where: {
          kyc_id: kycId,
          document_type: documentType,
          document_side: documentSide,
        },
      });

      if (existingDoc) {
        this.logger.log(`Replacing existing ${documentSide} side for ${documentType}`);
        await this.prisma.kyc_documents.delete({
          where: { document_id: existingDoc.document_id },
        });
      }
    }
    
    // Upload file to Cloudinary instead of local storage
    const uploadResult = await this.cloudinary.uploadFile(file, 'quantiva/kyc/documents');
    
    this.logger.log(`Document uploaded to Cloudinary: ${uploadResult.secureUrl}`);

    // Determine if this is primary (front side or single-sided document)
    const isPrimary = !documentSide || documentSide === 'front';

    // Create document record with Cloudinary URL
    const document = await this.prisma.kyc_documents.create({
      data: {
        kyc_id: kycId,
        storage_url: uploadResult.secureUrl, // Store the full Cloudinary URL
        document_type: documentType || null,
        document_side: documentSide || null,
        is_primary: isPrimary,
      },
    });

    return document.document_id;
  }

  async getDocument(kycId: string) {
    return this.prisma.kyc_documents.findFirst({
      where: { kyc_id: kycId },
      orderBy: { created_at: 'desc' },
    });
  }

  async getDocumentUploadStatus(kycId: string, documentType: string): Promise<{
    frontUploaded: boolean;
    backUploaded: boolean;
    frontDocId?: string;
    backDocId?: string;
    isComplete: boolean;
  }> {
    const documents = await this.prisma.kyc_documents.findMany({
      where: {
        kyc_id: kycId,
        document_type: documentType,
      },
      select: {
        document_id: true,
        document_side: true,
      },
    });

    const frontDoc = documents.find(d => d.document_side === 'front');
    const backDoc = documents.find(d => d.document_side === 'back');

    // Passport only needs front
    const requiresBack = documentType === 'id_card' || documentType === 'drivers_license';
    const isComplete = !!frontDoc && (!requiresBack || !!backDoc);

    return {
      frontUploaded: !!frontDoc,
      backUploaded: !!backDoc,
      frontDocId: frontDoc?.document_id,
      backDocId: backDoc?.document_id,
      isComplete,
    };
  }
}

