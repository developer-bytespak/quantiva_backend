import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';

export interface WsAuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

/**
 * Shared WebSocket authentication service.
 * Verifies JWT tokens from socket handshake and extracts userId.
 * Used by all WebSocket gateways to enforce authentication.
 */
@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);
  private readonly jwtSecret: string;

  constructor(private readonly configService: ConfigService) {
    const jwtConfig = this.configService.get('jwt');
    this.jwtSecret = jwtConfig?.secret;
    if (!this.jwtSecret) {
      this.logger.error('JWT secret is not configured — WebSocket auth will reject all connections');
    }
  }

  /**
   * Verify the JWT token from a socket connection handshake.
   * Expects token in `client.handshake.auth.token` or `client.handshake.query.token`.
   */
  verifyConnection(client: Socket): WsAuthResult {
    const token =
      client.handshake.auth?.token ||
      (client.handshake.query?.token as string);

    if (!token) {
      return { authenticated: false, error: 'Authentication token required' };
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret) as jwt.JwtPayload;
      const userId = decoded.sub || decoded.user_id;

      if (!userId) {
        return { authenticated: false, error: 'Invalid token payload — no user ID' };
      }

      return { authenticated: true, userId };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        return { authenticated: false, error: 'Token expired' };
      }
      return { authenticated: false, error: 'Invalid token' };
    }
  }
}
