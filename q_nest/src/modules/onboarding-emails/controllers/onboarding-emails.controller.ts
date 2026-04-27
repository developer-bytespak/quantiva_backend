import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReminderSchedulerService } from '../services/reminder-scheduler.service';
import { UnsubscribeTokenService } from '../services/unsubscribe-token.service';
import { UnsubscribeDto } from '../dto/unsubscribe.dto';

@Controller('onboarding')
export class OnboardingEmailsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ReminderSchedulerService,
    private readonly unsubscribeToken: UnsubscribeTokenService,
  ) {}

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(@Body() dto: UnsubscribeDto): Promise<{ success: true }> {
    const userId = await this.unsubscribeToken.verify(dto.token);

    await this.prisma.users.update({
      where: { user_id: userId },
      data: { onboarding_emails_opted_out: true },
    });

    await this.scheduler.cancelAll(userId);

    return { success: true };
  }
}
