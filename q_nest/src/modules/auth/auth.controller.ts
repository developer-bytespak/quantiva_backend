import { Controller, Post, Body, Get, Param, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginDto: { email: string; password: string }) {
    const user = await this.authService.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new Error('Invalid credentials');
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days
    const session = await this.authService.createSession(user.user_id, expiresAt);
    return { user, session };
  }

  @Post('logout')
  async logout(@Body() body: { sessionId: string }) {
    return this.authService.revokeSession(body.sessionId);
  }

  @Get('session/:id')
  async getSession(@Param('id') id: string) {
    return this.authService.findSession(id);
  }
}

