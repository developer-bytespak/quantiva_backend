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

    // For localhost development, use 'lax' sameSite and don't set domain
    // For production, use 'strict' and set domain if configured
    const cookieOptions: any = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax', // Use 'lax' for localhost development
      maxAge: maxAge * 1000, // Convert to milliseconds
      path: '/',
    };

    // Only set domain in production if configured
    if (isProduction && jwtConfig.cookieDomain) {
      cookieOptions.domain = jwtConfig.cookieDomain;
    }

    res.cookie(name, value, cookieOptions);
  }

  private clearCookie(res: Response, name: string) {
    const jwtConfig = this.configService.get('jwt');
    const cookieOptions: any = {
      httpOnly: true,
      secure: jwtConfig.isProduction,
      sameSite: jwtConfig.isProduction ? 'strict' : 'lax',
      path: '/',
    };

    // Only set domain in production if configured
    if (jwtConfig.isProduction && jwtConfig.cookieDomain) {
      cookieOptions.domain = jwtConfig.cookieDomain;
    }

    res.clearCookie(name, cookieOptions);
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
    // Revoke the specific session directly using session_id from JWT payload
    // This is much more efficient than matching refresh tokens
    if (user.session_id) {
      try {
        await this.sessionService.revokeSession(user.session_id);
      } catch (error) {
        // Log error but continue with logout to clear cookies
        console.error('Error revoking session during logout:', error);
      }
    } else {
      // Fallback for older tokens that don't have session_id
      // Try to revoke using refresh token as before
      const refreshToken = req.cookies?.refresh_token;
      try {
        await this.sessionService.revokeCurrentUserSession(user.sub, refreshToken);
      } catch (error) {
        console.error('Error revoking session during logout (fallback):', error);
      }
    }

    // Clear cookies - always clear even if session revocation failed
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

