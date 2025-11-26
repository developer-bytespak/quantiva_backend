import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class KycService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.kyc_verifications.findMany({
      include: {
        user: true,
        documents: true,
        face_matches: true,
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: id },
      include: {
        user: true,
        documents: true,
        face_matches: true,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.kyc_verifications.findMany({
      where: { user_id: userId },
      include: {
        user: true,
        documents: true,
        face_matches: true,
      },
    });
  }

  async create(data: {
    user_id: string;
    status?: string;
    decision_reason?: string;
  }) {
    return this.prisma.kyc_verifications.create({
      data,
      include: {
        user: true,
        documents: true,
        face_matches: true,
      },
    });
  }

  async update(id: string, data: {
    status?: string;
    decision_reason?: string;
  }) {
    return this.prisma.kyc_verifications.update({
      where: { kyc_id: id },
      data,
    });
  }

  async createDocument(kycId: string, data: {
    storage_url: string;
    ocr_name?: string;
    ocr_dob?: Date;
    ocr_confidence?: number;
  }) {
    return this.prisma.kyc_documents.create({
      data: {
        kyc_id: kycId,
        ...data,
      },
    });
  }

  async createFaceMatch(kycId: string, data: {
    photo_url: string;
    similarity?: number;
    is_match?: boolean;
  }) {
    return this.prisma.kyc_face_matches.create({
      data: {
        kyc_id: kycId,
        ...data,
      },
    });
  }
}

