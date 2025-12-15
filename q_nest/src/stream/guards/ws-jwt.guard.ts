import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const client: Socket = context.switchToWs().getClient();
      const authToken = this.extractTokenFromHandshake(client);

      if (!authToken) {
        throw new WsException('Missing authentication token');
      }

      // Verify JWT token
      const payload = await this.jwtService.verifyAsync(authToken);

      // Attach user info to client data for later use
      client.data.userId = payload.sub || payload.userId;
      client.data.user = payload;

      return true;
    } catch (error) {
      this.logger.error(`WebSocket authentication failed: ${error.message}`);
      throw new WsException('Invalid authentication token');
    }
  }

  private extractTokenFromHandshake(client: Socket): string | null {
    // Try to extract token from different sources
    
    // 1. From auth object in handshake
    const authToken = client.handshake?.auth?.token;
    if (authToken) {
      return authToken;
    }

    // 2. From query parameters
    const queryToken = client.handshake?.query?.token;
    if (queryToken && typeof queryToken === 'string') {
      return queryToken;
    }

    // 3. From headers (Authorization: Bearer <token>)
    const authHeader = client.handshake?.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const [type, token] = authHeader.split(' ');
      if (type === 'Bearer' && token) {
        return token;
      }
    }

    return null;
  }
}
