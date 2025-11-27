import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { SessionService } from '../services/session.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RefreshTokenGuard } from '../guards/refresh-token.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { Verify2FADto } from '../dto/verify-2fa.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { ConfigService } from '@nestjs/config';
import { TokenPayload } from '../services/token.service';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessionService: SessionService,
    private configService: ConfigService,
  ) {}

  private setCookie(
    res: Response,
    name: string,
    value: string,
    maxAge: number,
  ) {
    const jwtConfig = this.configService.get('jwt');
    const isProduction = jwtConfig.isProduction;

    res.cookie(name, value, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: maxAge * 1000, // Convert to milliseconds
      path: '/',
      domain: jwtConfig.cookieDomain,
    });
  }

  private clearCookie(res: Response, name: string) {
    const jwtConfig = this.configService.get('jwt');
    res.clearCookie(name, {
      httpOnly: true,
      secure: jwtConfig.isProduction,
      sameSite: 'strict',
      path: '/',
      domain: jwtConfig.cookieDomain,
    });
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.authService.login(loginDto, ipAddress);
  }

  @Public()
  @Post('verify-2fa')
  @HttpCode(HttpStatus.OK)
  async verify2FA(
    @Body() verify2FADto: Verify2FADto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;

    const result = await this.authService.verify2FA(
      verify2FADto,
      ipAddress,
      deviceId,
    );

    // Set cookies
    // Access token: 45 minutes
    this.setCookie(res, 'access_token', result.accessToken, 45 * 60);
    // Refresh token: 7 days
    this.setCookie(res, 'refresh_token', result.refreshToken, 7 * 24 * 60 * 60);

    return {
      user: result.user,
      message: 'Authentication successful',
    };
  }

  @Public()
  @UseGuards(RefreshTokenGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = (req as any).refreshToken;
    const result = await this.authService.refresh(refreshToken);

    // Set new cookies
    this.setCookie(res, 'access_token', result.accessToken, 45 * 60);
    this.setCookie(res, 'refresh_token', result.refreshToken, 7 * 24 * 60 * 60);

    return {
      message: 'Tokens refreshed successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: TokenPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.refresh_token;
    
    if (refreshToken) {
      // Find session by refresh token and revoke it
      const session = await this.sessionService.findSessionByRefreshToken(refreshToken);
      if (session) {
        await this.sessionService.revokeSession(session.session_id);
      }
    }

    // Clear cookies
    this.clearCookie(res, 'access_token');
    this.clearCookie(res, 'refresh_token');

    return { message: 'Logged out successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('request-password-change-code')
  @HttpCode(HttpStatus.OK)
  async requestPasswordChangeCode(@CurrentUser() user: TokenPayload) {
    return this.authService.requestPasswordChangeCode(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: TokenPayload,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.sub, changePasswordDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() user: TokenPayload) {
    return this.authService.getUserById(user.sub);
  }
}

