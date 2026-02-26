import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminTokenService } from './services/admin-token.service';
import { AdminSessionService } from './services/admin-session.service';
import { AdminSettingsService } from './services/admin-settings.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { AdminOrUserJwtGuard } from './guards/admin-or-user-jwt.guard';
import { PrismaModule } from '../../prisma/prisma.module';

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
          secret: jwtConfig.secret,
          signOptions: { expiresIn: jwtConfig.accessTokenExpiry },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AdminAuthController],
  providers: [
    AdminAuthService,
    AdminTokenService,
    AdminSessionService,
    AdminSettingsService,
    AdminJwtStrategy,
    AdminJwtAuthGuard,
    AdminOrUserJwtGuard,
  ],
  exports: [
    AdminAuthService,
    AdminTokenService,
    AdminSessionService,
    AdminJwtAuthGuard,
    AdminOrUserJwtGuard,
  ],
})
export class AdminAuthModule {}
