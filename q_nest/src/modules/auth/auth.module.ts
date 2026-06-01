import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { TokenService } from './services/token.service';
import { SessionService } from './services/session.service';
import { TwoFactorService } from './services/two-factor.service';
import { RateLimitService } from './services/rate-limit.service';
import { AuthEmailService } from './services/auth-email.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { TwoFactorGuard } from './guards/two-factor.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycModule } from '../../kyc/kyc.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { AppGateway } from 'src/gateways/app.gateway';
import { FirebaseService } from 'src/firebase/firebase.service';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    forwardRef(() => SubscriptionsModule),
    NotificationsModule,
    KycModule,
    OnboardingEmailsModule,
    AffiliateModule,
    PassportModule,
    ConfigModule,
    ScheduleModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const jwtConfig = configService.get('jwt');
        return {
          secret: jwtConfig.secret,
          signOptions: {
            expiresIn: jwtConfig.accessTokenExpiry,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SessionService,
    TwoFactorService,
    RateLimitService,
    AuthEmailService,
    AppGateway,
    JwtStrategy,
    JwtAuthGuard,
    RefreshTokenGuard,
    TwoFactorGuard,
    FirebaseService,
  ],
  exports: [
    AuthService,
    TokenService,
    SessionService,
    JwtAuthGuard,
    AuthEmailService,
  ],
})
export class AuthModule {}
