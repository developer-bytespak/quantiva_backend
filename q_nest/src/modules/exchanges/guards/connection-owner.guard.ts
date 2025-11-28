import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ExchangesService } from '../exchanges.service';
import { TokenPayload } from '../../auth/services/token.service';
import { ConnectionNotFoundException } from '../exceptions/binance.exceptions';

@Injectable()
export class ConnectionOwnerGuard implements CanActivate {
  constructor(private exchangesService: ExchangesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as TokenPayload;
    const connectionId = request.params.connectionId;

    if (!user || !user.sub) {
      throw new ForbiddenException('User not authenticated');
    }

    if (!connectionId) {
      throw new ForbiddenException('Connection ID is required');
    }

    const connection = await this.exchangesService.getConnectionById(connectionId);

    if (!connection) {
      throw new ConnectionNotFoundException();
    }

    if (connection.user_id !== user.sub) {
      throw new ForbiddenException('You do not have access to this connection');
    }

    return true;
  }
}

