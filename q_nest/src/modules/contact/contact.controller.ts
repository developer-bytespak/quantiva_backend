import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // Public endpoint — homepage contact form (no auth required)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submitPublic(@Body() dto: CreateContactDto) {
    await this.contactService.create({ ...dto, source: dto.source || 'homepage' });
    return { message: 'Your message has been sent successfully. We will get back to you within 24 hours.' };
  }

  // Authenticated endpoint — help-support page contact form
  @Post('submit-inquiry')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async submitAuthenticated(
    @Body() dto: CreateContactDto,
    @CurrentUser() user: TokenPayload,
  ) {
    await this.contactService.create({ ...dto, source: dto.source || 'help-support' }, user.sub);
    return { message: 'Your message has been sent successfully. We will get back to you within 24 hours.' };
  }
}
