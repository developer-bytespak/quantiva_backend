import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { AffiliateAuthController } from './controllers/affiliate-auth.controller';
import { AffiliateDashboardController } from './controllers/affiliate-dashboard.controller';
import { AffiliateAuthService } from './services/affiliate-auth.service';
import { AffiliateTokenService } from './services/affiliate-token.service';
import { AffiliateSessionService } from './services/affiliate-session.service';
import { AffiliateAttributionService } from './services/affiliate-attribution.service';
import { AffiliateCommissionService } from './services/affiliate-commission.service';
import { AffiliateStatsService } from './services/affiliate-stats.service';
import { AffiliateSettingsService } from './services/affiliate-settings.service';
import { AffiliateEmailService } from './services/affiliate-email.service';
import { EmailSenderService } from '../onboarding-emails/services/email-sender.service';
import { AffiliateJwtStrategy } from './strategies/affiliate-jwt.strategy';
import { AffiliateJwtAuthGuard } from './guards/affiliate-jwt-auth.guard';
import { AffiliateApprovedGuard } from './guards/affiliate-approved.guard';

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    ConfigModule,
    ScheduleModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const jwtConfig = configService.get('jwt');
        return {
          secret: jwtConfig.affiliateSecret,
          signOptions: { expiresIn: jwtConfig.accessTokenExpiry },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AffiliateAuthController, AffiliateDashboardController],
  providers: [
    AffiliateAuthService,
    AffiliateTokenService,
    AffiliateSessionService,
    AffiliateAttributionService,
    AffiliateCommissionService,
    AffiliateStatsService,
    AffiliateSettingsService,
    AffiliateEmailService,
    EmailSenderService,
    AffiliateJwtStrategy,
    AffiliateJwtAuthGuard,
    AffiliateApprovedGuard,
  ],
  exports: [
    JwtModule,
    AffiliateAuthService,
    AffiliateTokenService,
    AffiliateSessionService,
    AffiliateAttributionService,
    AffiliateCommissionService,
    AffiliateStatsService,
    AffiliateSettingsService,
    AffiliateEmailService,
    AffiliateJwtAuthGuard,
    AffiliateApprovedGuard,
  ],
})
export class AffiliateModule {}
