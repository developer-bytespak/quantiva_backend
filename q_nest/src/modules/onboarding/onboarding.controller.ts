import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('progress')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getProgress(@CurrentUser() user: TokenPayload) {
    return this.onboardingService.getProgress(user.sub);
  }

  @Post('acknowledge-free-tier')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async acknowledgeFreeTier(@CurrentUser() user: TokenPayload) {
    return this.onboardingService.acknowledgeFreeTier(user.sub);
  }

  @Get('free-signal-trades')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getFreeSignalTradesQuota(@CurrentUser() user: TokenPayload) {
    return this.onboardingService.getFreeSignalTradesQuota(user.sub);
  }
}
