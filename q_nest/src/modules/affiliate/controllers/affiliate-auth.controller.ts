import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../../common/decorators/public.decorator';
import { AffiliateAuthService } from '../services/affiliate-auth.service';
import {
  AffiliateTokenPayload,
  AffiliateTokenService,
} from '../services/affiliate-token.service';
import { AffiliateSessionService } from '../services/affiliate-session.service';
import { AffiliateJwtAuthGuard } from '../guards/affiliate-jwt-auth.guard';
import {
  CurrentAffiliate,
  CurrentAffiliatePayload,
} from '../decorators/current-affiliate.decorator';
import { AffiliateSignupDto } from '../dto/affiliate-signup.dto';
import { AffiliateLoginDto } from '../dto/affiliate-login.dto';
import {
  SendAffiliateCodeDto,
  VerifyAffiliateCodeDto,
} from '../dto/affiliate-email-code.dto';

@Controller('affiliate')
export class AffiliateAuthController {
  constructor(
    private affiliateAuthService: AffiliateAuthService,
    private affiliateTokenService: AffiliateTokenService,
    private affiliateSessionService: AffiliateSessionService,
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

  private writeAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    this.setCookie(res, 'affiliate_access_token', accessToken, 45 * 60);
    this.setCookie(
      res,
      'affiliate_refresh_token',
      refreshToken,
      7 * 24 * 60 * 60,
    );
  }

  // ── Auth Endpoints ──

  @Public()
  @Post('auth/send-code')
  @HttpCode(HttpStatus.OK)
  async sendCode(@Body() dto: SendAffiliateCodeDto) {
    return this.affiliateAuthService.sendEmailCode(dto.email);
  }

  @Public()
  @Post('auth/verify-code')
  @HttpCode(HttpStatus.OK)
  async verifyCode(@Body() dto: VerifyAffiliateCodeDto) {
    return this.affiliateAuthService.verifyEmailCode(dto.email, dto.code);
  }

  @Public()
  @Post('auth/signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() dto: AffiliateSignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;

    const result = await this.affiliateAuthService.signup(
      dto,
      ipAddress,
      deviceId,
    );

    this.writeAuthCookies(res, result.accessToken, result.refreshToken);

    return {
      affiliate: result.affiliate,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      message:
        'Application received. You can log in to track its status while we review.',
    };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: AffiliateLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;

    const result = await this.affiliateAuthService.login(
      loginDto,
      ipAddress,
      deviceId,
    );

    this.writeAuthCookies(res, result.accessToken, result.refreshToken);

    return {
      affiliate: result.affiliate,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      message: 'Affiliate authentication successful',
    };
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') refreshTokenFromBody?: string,
  ) {
    const refreshToken =
      req?.cookies?.affiliate_refresh_token ?? refreshTokenFromBody;
    if (!refreshToken) {
      return res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ message: 'Affiliate refresh token not found' });
    }

    const result = await this.affiliateAuthService.refresh(refreshToken);

    this.writeAuthCookies(res, result.accessToken, result.refreshToken);

    return {
      message: 'Affiliate tokens refreshed successfully',
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
    let tokenPayload: AffiliateTokenPayload | null = null;

    try {
      const authHeader = req.headers.authorization;
      let token: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (req.cookies?.affiliate_access_token) {
        token = req.cookies.affiliate_access_token;
      }

      if (token) {
        tokenPayload = this.affiliateTokenService.decodeToken(token);
      }
    } catch {
      // ignore — still clear cookies
    }

    if (tokenPayload?.session_id) {
      try {
        await this.affiliateSessionService.deleteSession(
          tokenPayload.session_id,
        );
      } catch {
        // ignore
      }
    }

    this.clearCookie(res, 'affiliate_access_token');
    this.clearCookie(res, 'affiliate_refresh_token');

    return { message: 'Affiliate logged out successfully' };
  }

  @UseGuards(AffiliateJwtAuthGuard)
  @Get('auth/me')
  async getCurrentAffiliate(
    @CurrentAffiliate() affiliate: CurrentAffiliatePayload,
  ) {
    return this.affiliateAuthService.getAffiliateById(affiliate.sub);
  }
}
