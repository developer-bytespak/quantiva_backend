import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { ContactEmailService } from './contact-email.service';

@Module({
  imports: [PrismaModule],
  controllers: [ContactController],
  providers: [ContactService, ContactEmailService],
})
export class ContactModule {}
