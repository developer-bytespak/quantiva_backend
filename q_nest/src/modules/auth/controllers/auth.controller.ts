import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  Res,
  Delete,
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
import { DeleteAccountDto } from '../dto/delete-account.dto';
import { VerifyPasswordDto } from '../dto/verify-password.dto';
import { ConfigService } from '@nestjs/config';
import { TokenPayload, TokenService } from '../services/token.service';
import { isNegative } from 'class-validator';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessionService: SessionService,
    private configService: ConfigService,
    private tokenService: TokenService,
  ) {}

  private setCookie(
    res: Response,
    name: string,
    value: string,
    maxAge: number,
  ) {
    const jwtConfig = this.configService.get('jwt');
    const crossOrigin = jwtConfig.useCrossOriginCookies ?? jwtConfig.isProduction;

    // crossOrigin: SameSite=None + Secure so browser sends cookie on cross-origin requests
    // (e.g. Vercel frontend → Render backend, or localhost frontend → Render backend)
    const cookieOptions: any = {
      httpOnly: true,
      secure: crossOrigin, // Secure required when SameSite=None
      sameSite: crossOrigin ? 'none' : 'lax',
      maxAge: maxAge * 1000,
      path: '/',
    };

    // Do not set cookie domain explicitly. Let the browser scope the cookie to the
    // backend host that set it.

    res.cookie(name, value, cookieOptions);
  }

  private clearCookie(res: Response, name: string) {
    const jwtConfig = this.configService.get('jwt');
    const crossOrigin = jwtConfig.useCrossOriginCookies ?? jwtConfig.isProduction;
    const cookieOptions: any = {
      httpOnly: true,
      secure: crossOrigin,
      sameSite: crossOrigin ? 'none' : 'lax',
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

    // Check if 2FA is required or if tokens are returned directly
    if ('accessToken' in result && 'refreshToken' in result) {
      // 2FA is disabled - tokens returned directly, set cookies
      const tokenResult = result as any;
      // Access token: 45 minutes
      this.setCookie(res, 'access_token', tokenResult.accessToken, 45 * 60);
      // Refresh token: 7 days
      this.setCookie(res, 'refresh_token', tokenResult.refreshToken, 7 * 24 * 60 * 60);

      // Return tokens in response body as fallback for cross-origin cookie issues
      return {
        user: tokenResult.user,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        sessionId: tokenResult.sessionId,
        message: 'Authentication successful',
      };
    }

    // 2FA is required (original flow)
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

    // Return tokens in response body as fallback for cross-origin cookie issues
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      message: 'Authentication successful',
    };
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleLogin(
    @Body() body: { idToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;
    const result = await this.authService.loginWithGoogle(body.idToken, ipAddress, deviceId);
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      isNewUser: result.user.isNewUser,
      message: 'Authentication successful',
    };
  }

  @Public()
  @Post('signup/google')
  @HttpCode(HttpStatus.OK)
  async googleSignup(
    @Body() body: { idToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const deviceId = req.headers['x-device-id'] as string;
    const result = await this.authService.signupWithGoogle(body.idToken, ipAddress, deviceId);
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      isNewUser: result.user.isNewUser,
      message: 'Signup successful',
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

    // Return tokens in response body for localStorage fallback (cross-origin scenarios)
    return {
      message: 'Tokens refreshed successfully',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
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
    // Since @Public() routes skip JWT guard, we need to manually extract token to get session_id
    let tokenPayload: TokenPayload | null = null;

    // Manually extract and decode token from Authorization header or cookies
    try {
      const authHeader = req.headers.authorization;
      let token: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (req.cookies?.access_token) {
        token = req.cookies.access_token;
      }

      if (token) {
        // Decode (not verify) the token - we don't verify because token might be expired
        // but we still want the session_id from it
        tokenPayload = this.tokenService.decodeToken(token);
      }
    } catch (error) {
      console.warn('Could not decode token during logout:', error);
    }

    // Use decoded token payload if available, otherwise fall back to user from guard (if any)
    const effectiveUser = tokenPayload || user;

    // If user is authenticated via cookies/JWT, try to delete their session server-side.
    if (effectiveUser && effectiveUser.sub) {
      let sessionDeleted = false;

      // Delete the specific session directly using session_id from JWT payload
      // This is much more efficient than matching refresh tokens
      if (effectiveUser.session_id) {
        try {
          sessionDeleted = await this.sessionService.deleteSession(effectiveUser.session_id);
          console.log(`Session ${effectiveUser.session_id} deleted successfully for user ${effectiveUser.sub}`);
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
              effectiveUser.sub,
            );
            if (session) {
              sessionDeleted = await this.sessionService.deleteSession(session.session_id);
              console.log(`Session ${session.session_id} deleted via refresh token for user ${effectiveUser.sub}`);
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
          await this.sessionService.revokeCurrentUserSession(effectiveUser.sub);
          console.log(`Most recent session revoked for user ${effectiveUser.sub}`);
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
  @Post('verify-password')
  @HttpCode(HttpStatus.OK)
  async verifyPassword(
    @CurrentUser() user: TokenPayload,
    @Body() verifyPasswordDto: VerifyPasswordDto,
  ) {
    return this.authService.verifyPassword(user.sub, verifyPasswordDto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() user: TokenPayload) {
    return this.authService.getUserById(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('request-delete-account-code')
  @HttpCode(HttpStatus.OK)
  async requestDeleteAccountCode(@CurrentUser() user: TokenPayload) {
    return this.authService.requestDeleteAccountCode(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('delete-account')
  @HttpCode(HttpStatus.OK)
  async deleteAccount(
    @CurrentUser() user: TokenPayload,
    @Body() deleteAccountDto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Delete account
    const result = await this.authService.deleteAccount(
      user.sub,
      deleteAccountDto,
    );

    // Clear authentication cookies after successful deletion
    this.clearCookie(res, 'access_token');
    this.clearCookie(res, 'refresh_token');

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Post('check-google-email')
  @HttpCode(HttpStatus.OK)
  async verifyGoogleEmail(@CurrentUser() user: TokenPayload) {
    const result = await this.authService.verifyGoogleEmail(user.sub);
    console.log("result", result);
    return result;
  }

  @Post('forgot-password/send-otp')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: { email: string }) {
    const result = await this.authService.forgotPassword(body.email);
    console.log("result", result);
    return result;
  }

  @Post('forgot-password/verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() body: { email: string, code: string }) {
    const result = await this.authService.verifyOtp(body.email, body.code);
    console.log("result", result);
    return result;
  }

  @Post('forgot-password/reset')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: { email: string, newPassword: string }) {
    const result = await this.authService.resetPassword(body.email, body.newPassword);
    console.log("result", result);
    return result;
  }
}

