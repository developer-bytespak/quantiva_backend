import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';

@Injectable()
export class ContactService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateContactDto, userId?: string) {
    return this.prisma.contact_submissions.create({
      data: {
        name: dto.name,
        email: dto.email,
        company: dto.company || null,
        phone: dto.phone || null,
        subject: dto.subject,
        message: dto.message,
        source: dto.source || 'homepage',
        user_id: userId || null,
      },
    });
  }
}
