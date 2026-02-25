import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AdminAuthService } from '../services/admin-auth.service';
import { AdminSettingsService } from '../services/admin-settings.service';
import { AdminTokenService, AdminTokenPayload } from '../services/admin-token.service';
import { AdminSessionService } from '../services/admin-session.service';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminLoginDto } from '../dto/admin-login.dto';
import {
  UpdateBinanceSettingsDto,
  UpdateFeeSettingsDto,
} from '../dto/update-admin-settings.dto';

@Controller('admin')
export class AdminAuthController {
  constructor(
    private adminAuthService: AdminAuthService,
    private adminSettingsService: AdminSettingsService,
    private adminTokenService: AdminTokenService,
    private adminSessionService: AdminSessionService,
    private configService: ConfigService,
  ) {}

  private setCookie(res: Response, name: string, value: string, maxAge: number) {
    const jwtConfig = this.configService.get('jwt');
    const crossOrigin =
      jwtConfig.useCrossOriginCookies ?? jwtConfig.isProduction;

    res.cookie(name, value, {
      httpOnly: true,
      secure: crossOrigin,
      sameSite: crossOrigin ? 'none' : 'lax',
      maxAge: maxAge * 1000,
      path: '/',
    });
  }

  private clearCookie(res: Response, name: string) {
    const jwtConfig = this.configService.get('jwt');
    const crossOrigin =
      jwtConfig.useCrossOriginCookies ?? jwtConfig.isProduction;

    res.clearCookie(name, {
      httpOnly: true,
      secure: crossOrigin,
      sameSite: crossOrigin ? 'none' : 'lax',
      path: '/',
    });
  }

  // ── Auth Endpoints ──

  @Public()
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: AdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;

    const result = await this.adminAuthService.login(
      loginDto,
      ipAddress,
      deviceId,
    );

    this.setCookie(res, 'admin_access_token', result.accessToken, 45 * 60);
    this.setCookie(
      res,
      'admin_refresh_token',
      result.refreshToken,
      7 * 24 * 60 * 60,
    );

    return {
      admin: result.admin,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      message: 'Admin authentication successful',
    };
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req?.cookies?.admin_refresh_token;
    if (!refreshToken) {
      return res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ message: 'Admin refresh token not found' });
    }

    const result = await this.adminAuthService.refresh(refreshToken);

    this.setCookie(res, 'admin_access_token', result.accessToken, 45 * 60);
    this.setCookie(
      res,
      'admin_refresh_token',
      result.refreshToken,
      7 * 24 * 60 * 60,
    );

    return {
      message: 'Admin tokens refreshed successfully',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    let tokenPayload: AdminTokenPayload | null = null;

    try {
      const authHeader = req.headers.authorization;
      let token: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (req.cookies?.admin_access_token) {
        token = req.cookies.admin_access_token;
      }

      if (token) {
        tokenPayload = this.adminTokenService.decodeToken(token);
      }
    } catch {
      // Token decode failure is okay during logout
    }

    if (tokenPayload?.session_id) {
      try {
        await this.adminSessionService.deleteSession(
          tokenPayload.session_id,
        );
      } catch {
        // If session delete fails, still clear cookies
      }
    }

    this.clearCookie(res, 'admin_access_token');
    this.clearCookie(res, 'admin_refresh_token');

    return { message: 'Admin logged out successfully' };
  }

  // ── Settings Endpoints ──

  @UseGuards(AdminJwtAuthGuard)
  @Get('settings')
  async getSettings(@CurrentAdmin() admin: AdminTokenPayload) {
    return this.adminSettingsService.getSettings(admin.sub);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Put('settings/binance')
  async updateBinanceSettings(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: UpdateBinanceSettingsDto,
  ) {
    return this.adminSettingsService.updateBinanceSettings(admin.sub, dto);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Put('settings/fees')
  async updateFeeSettings(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: UpdateFeeSettingsDto,
  ) {
    return this.adminSettingsService.updateFeeSettings(admin.sub, dto);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Put('settings/stripe')
  @HttpCode(HttpStatus.OK)
  async updateStripeSettings() {
    return {
      message: 'Stripe integration coming in Phase 2',
      status: 'not_available',
    };
  }

  @UseGuards(AdminJwtAuthGuard)
  @Get('auth/me')
  async getMe(@CurrentAdmin() admin: AdminTokenPayload) {
    return this.adminAuthService.getAdminById(admin.sub);
  }

}
