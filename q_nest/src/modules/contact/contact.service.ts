import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { ContactEmailService } from './contact-email.service';

@Injectable()
export class ContactService {
  constructor(
    private prisma: PrismaService,
    private readonly contactEmailService: ContactEmailService,
  ) {}

  async create(dto: CreateContactDto, userId?: string) {
    const submission = await this.prisma.contact_submissions.create({
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

    await this.contactEmailService.sendAdminContactNotification({
      name: submission.name,
      email: submission.email,
      company: submission.company,
      phone: submission.phone,
      subject: submission.subject,
      message: submission.message,
      source: submission.source,
     
      createdAt: submission.created_at,
    });

    return submission;
  }
}
