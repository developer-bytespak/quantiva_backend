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
    // For production, use 'none' to allow cross-site cookies (required when frontend and backend are on different domains)
    const cookieOptions: any = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax', // Use 'lax' for localhost development; 'none' in production for cross-site cookies
      maxAge: maxAge * 1000, // Convert to milliseconds
      path: '/',
    };

    // Do not set cookie domain explicitly. Let the browser scope the cookie to the
    // backend host that set it. Setting a cross-site domain here can prevent the
    // browser from sending the cookie on subsequent requests.

    res.cookie(name, value, cookieOptions);
  }

  private clearCookie(res: Response, name: string) {
    const jwtConfig = this.configService.get('jwt');
    const cookieOptions: any = {
      httpOnly: true,
      secure: jwtConfig.isProduction,
      sameSite: jwtConfig.isProduction ? 'none' : 'lax',
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const result = await this.authService.login(loginDto, ipAddress);

    // If 2FA is disabled and tokens are returned directly, set cookies
    if (result.accessToken && result.refreshToken) {
      // Access token: 45 minutes
      this.setCookie(res, 'access_token', result.accessToken, 45 * 60);
      // Refresh token: 7 days
      this.setCookie(res, 'refresh_token', result.refreshToken, 7 * 24 * 60 * 60);

      // Return tokens in response body as fallback for cross-origin cookie issues
      return {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        sessionId: result.sessionId,
        message: 'Authentication successful',
      };
    }

    // If 2FA is still required (original flow)
    return result;
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
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(
    @Body() body: { idToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;

    const result = await this.authService.loginWithGoogle(body.idToken, ipAddress, deviceId);

    // Return tokens in response body (client JWT flow)
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
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

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: TokenPayload | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Note: logout is @Public because client-JWT logout relies on client removing tokens from localStorage.
    // If user is authenticated via cookies/JWT, try to revoke their session server-side.
    if (user && user.sub) {
      let sessionDeleted = false;

      // Delete the specific session directly using session_id from JWT payload
      // This is much more efficient than matching refresh tokens
      if (user.session_id) {
        try {
          sessionDeleted = await this.sessionService.deleteSession(user.session_id);
        } catch (error) {
          // Log error but continue with logout to clear cookies
          console.error('Error deleting session during logout:', error);
        }
      }

      // If session_id delete didn't work, try fallback with refresh token
      if (!sessionDeleted) {
        const refreshToken = req.cookies?.refresh_token;
        if (refreshToken) {
          try {
            // Find session by refresh token and delete it
            const session = await this.sessionService.findSessionByRefreshTokenAndUser(
              refreshToken,
              user.sub,
            );
            if (session) {
              sessionDeleted = await this.sessionService.deleteSession(session.session_id);
            }
          } catch (error) {
            console.error('Error deleting session during logout (fallback):', error);
          }
        }
      }

      // If still not deleted, try to revoke the most recent session for this user
      // (as a fallback, we revoke instead of delete to ensure cleanup)
      if (!sessionDeleted) {
        try {
          await this.sessionService.revokeCurrentUserSession(user.sub);
        } catch (error) {
          console.error('Error revoking session during logout (final fallback):', error);
        }
      }
    }

    // Clear cookies - always clear even if session deletion failed
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

