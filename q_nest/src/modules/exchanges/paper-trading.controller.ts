import { Controller, Get, Query, Headers } from '@nestjs/common';
import { BinanceUserWsService } from './services/binance-user-ws.service';
import { TokenService } from '../auth/services/token.service';

@Controller('paper-trading')
export class PaperTradingController {
  constructor(
    private readonly binanceUserWsService: BinanceUserWsService,
    private readonly tokenService: TokenService,
  ) {}

  @Get('health')
  async health(
    @Query('userId') userId?: string,
    @Query('probe') probe?: string,
    @Headers('authorization') authorization?: string,
  ) {
    // If Authorization header provided and no userId query, try to decode
    if (!userId && authorization && authorization.startsWith('Bearer ')) {
      const token = authorization.replace(/^Bearer\s+/i, '');
      try {
        const decoded = await this.tokenService.decodeToken(token);
        if (decoded?.sub) userId = decoded.sub as string;
      } catch (e) {
        // ignore decode errors - we'll return generic info
      }
    }

    const stats = this.binanceUserWsService.getStats();
    const rate = this.binanceUserWsService.getRateLimitStatus();

    const userConn = userId ? stats.connections.find((c: any) => c.userId === userId) : null;
    const userConnected = !!userConn && !!userConn.connected;
    const userReconnectAttempts = userConn?.reconnectAttempts ?? 0;
    const userLastKeepaliveMsAgo = userConn?.lastKeepalive ? Date.now() - userConn.lastKeepalive : null;
    const lastBalance = userId ? this.binanceUserWsService.getLastBalance(userId) : null;

    // Note: probe is intentionally NOT implemented here to avoid any Binance calls by default
    return {
      gatewayUp: true,
      serverTime: new Date().toISOString(),
      totalConnections: stats.totalConnections,
      userConnected,
      userReconnectAttempts,
      userLastKeepaliveMsAgo,
      lastBalance,
      lastOrders: lastBalance ? this.binanceUserWsService.getLastOrders(userId as string) : [],
      rateLimited: rate.rateLimited,
      rateLimitRemainingMs: rate.remainingMs,
      message: rate.rateLimited ? 'RATE_LIMITED' : (userConnected ? 'Gateway online, user stream active' : 'Gateway online, no user stream'),
    };
  }

  @Get('data')
  async realtimeData(
    @Query('userId') userId?: string,
    @Query('mock') mock?: string,
    @Headers('authorization') authorization?: string,
  ) {
    // Dev-only: return mock data if requested to allow frontend testing without Binance
    if (mock === 'true' && process.env.NODE_ENV !== 'production') {
      return {
        gatewayUp: true,
        serverTime: new Date().toISOString(),
        userConnected: true,
        lastBalance: {
          USDT: { free: '1000.00', locked: '0.00', timestamp: Date.now() },
          BTC: { free: '0.0012', locked: '0.0000', timestamp: Date.now() }
        },
        lastOrders: [
          { orderId: '12345', symbol: 'BTCUSDT', side: 'BUY', status: 'NEW', price: '30000', quantity: '0.001', executedQuantity: '0', timestamp: Date.now() },
          { orderId: '12344', symbol: 'ETHUSDT', side: 'SELL', status: 'FILLED', price: '2000', quantity: '0.5', executedQuantity: '0.5', timestamp: Date.now() - 60000 }
        ],
        rateLimited: false,
        rateLimitRemainingMs: 0,
        message: 'Mock realtime data (development only)'
      };
    }
    // If Authorization header provided and no userId query, try to decode
    if (!userId && authorization && authorization.startsWith('Bearer ')) {
      const token = authorization.replace(/^Bearer\s+/i, '');
      try {
        const decoded = await this.tokenService.decodeToken(token);
        if (decoded?.sub) userId = decoded.sub as string;
      } catch (e) {
        // ignore decode errors - we'll return generic info
      }
    }

    if (!userId) {
      return { error: 'userId required (query or Authorization header)' };
    }

    const stats = this.binanceUserWsService.getStats();
    const rate = this.binanceUserWsService.getRateLimitStatus();

    const userConn = stats.connections.find((c: any) => c.userId === userId) || null;
    const userConnected = !!userConn && !!userConn.connected;
    const lastBalance = this.binanceUserWsService.getLastBalance(userId) || {};
    const lastOrders = this.binanceUserWsService.getLastOrders(userId);

    return {
      gatewayUp: true,
      serverTime: new Date().toISOString(),
      userConnected,
      lastBalance,
      lastOrders,
      rateLimited: rate.rateLimited,
      rateLimitRemainingMs: rate.remainingMs,
      message: rate.rateLimited ? 'RATE_LIMITED' : (userConnected ? 'Realtime data available' : 'No realtime data for user'),
    };
  }
}
