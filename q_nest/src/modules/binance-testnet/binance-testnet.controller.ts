import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { BinanceTestnetService } from './services/binance-testnet.service';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { PlaceTestnetOrderDto } from './dto/place-testnet-order.dto';

/**
 * Binance Testnet Paper Trading Controller
 *
 * Single account testnet trading via environment variables.
 * All endpoints require JWT authentication.
 */
@Controller('binance-testnet')
@UseGuards(JwtAuthGuard)
export class BinanceTestnetController {
  constructor(private readonly binanceTestnetService: BinanceTestnetService) {}

  /**
   * Get testnet status and configuration
   * @route GET /binance-testnet/status
   */
  @Public()
  @Get('status')
  getStatus() {
    return this.binanceTestnetService.getStatus();
  }

  /**
   * Verify testnet connection
   * @route POST /binance-testnet/verify
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify() {
    const isValid = await this.binanceTestnetService.verifyConnection();
    return { valid: isValid };
  }

  /**
   * Get account balance
   * @route GET /binance-testnet/balance
   */
  @Public()
  @Get('balance')
  async getAccountBalance() {
    try {
      return await this.binanceTestnetService.getAccountBalance();
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch account balance');
    }
  }

  /**
   * Get open orders
   * @route GET /binance-testnet/orders
   */
  @Public()
  @Get('orders')
  async getOpenOrders(@Query('symbol') symbol?: string) {
    try {
      return await this.binanceTestnetService.getOpenOrders(symbol);
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch open orders');
    }
  }

  /**
   * Get all orders (including filled)
   * @route GET /binance-testnet/orders/all
   */
  @Public()
  @Get('orders/all')
  async getAllOrders(
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: number,
  ) {
    try {
      return await this.binanceTestnetService.getAllOrders(symbol, limit || 20);
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch all orders');
    }
  }

  /**
   * Place an order
   * @route POST /binance-testnet/orders/place
   */
  @Public()
  @Post('orders/place')
  @HttpCode(HttpStatus.CREATED)
  async placeOrder(@Body() dto: PlaceTestnetOrderDto) {
    return this.binanceTestnetService.placeOrder(
      dto.symbol,
      dto.side,
      dto.type,
      dto.quantity,
      dto.price,
    );
  }

  /**
   * Cancel an order
   * @route DELETE /binance-testnet/orders/:orderId
   */
  @Delete('orders/:orderId')
  @HttpCode(HttpStatus.OK)
  async cancelOrder(
    @Param('orderId') orderId: string,
    @Query('symbol') symbol: string,
  ) {
    return this.binanceTestnetService.cancelOrder(symbol, parseInt(orderId, 10));
  }

  /**
   * Get ticker price
   * @route GET /binance-testnet/ticker/:symbol
   */
  @Public()
  @Get('ticker/:symbol')
  async getTickerPrice(@Param('symbol') symbol: string) {
    return this.binanceTestnetService.getTickerPrice(symbol);
  }

  /**
   * Get order book
   * @route GET /binance-testnet/orderbook/:symbol
   */
  @Get('orderbook/:symbol')
  async getOrderBook(
    @Param('symbol') symbol: string,
    @Query('limit') limit?: number,
  ) {
    return this.binanceTestnetService.getOrderBook(symbol, limit);
  }

  /**
   * Get recent trades
   * @route GET /binance-testnet/trades/:symbol
   */
  @Get('trades/:symbol')
  async getRecentTrades(
    @Param('symbol') symbol: string,
    @Query('limit') limit?: number,
  ) {
    return this.binanceTestnetService.getRecentTrades(symbol, limit);
  }

  /**
   * Get 24h ticker data
   * @route GET /binance-testnet/ticker24h/:symbol
   */
  @Get('ticker24h/:symbol')
  async get24hTicker(@Param('symbol') symbol: string) {
    return this.binanceTestnetService.get24hTicker(symbol);
  }

  /**
   * Get candlestick data
   * @route GET /binance-testnet/candles/:symbol
   */
  @Get('candles/:symbol')
  async getCandlestick(
    @Param('symbol') symbol: string,
    @Query('interval') interval?: string,
    @Query('limit') limit?: number,
  ) {
    return this.binanceTestnetService.getCandlestick(symbol, interval, limit);
  }

  /**
   * Get dashboard data (combined)
   * @route GET /binance-testnet/dashboard
   */
  @Get('dashboard')
  async getDashboardData(@Query('symbols') symbols: string = 'BTCUSDT,ETHUSDT') {
    const symbolList = symbols.split(',').map((s) => s.trim());
    return this.binanceTestnetService.getDashboardData(symbolList);
  }
}
