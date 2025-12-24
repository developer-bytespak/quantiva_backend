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
  Logger,
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
  private readonly logger = new Logger(BinanceTestnetController.name);

  // Fallback trading symbols if unable to fetch account symbols
  private readonly DEFAULT_TRADING_SYMBOLS = [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'XRPUSDT',
    'ADAUSDT',
    'DOGEUSDT',
    'SHIBUSDT',
    'SOLUSDT',
    'MATICUSDT',
    'LINKUSDT',
    'ZECUSDT',
    'XMRUSDT',
    'LTCUSDT',
    'EOSUSDT',
    'FILUSDT',
    'THETAUSDT',
  ];

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
   * Get available trading symbols
   * @route GET /binance-testnet/symbols
   */
  @Public()
  @Get('symbols')
  async getAvailableSymbols() {
    try {
      // Try to get symbols from account balances
      const accountInfo = await this.binanceTestnetService.getAccountInfo();
      const accountSymbols = new Set<string>();
      
      if (accountInfo?.balances && Array.isArray(accountInfo.balances)) {
        for (const balance of accountInfo.balances) {
          const asset = balance.asset;
          if (asset && asset !== 'USDT' && asset !== 'BUSD') {
            accountSymbols.add(`${asset}USDT`);
          }
        }
      }
      
      const symbols = Array.from(new Set([...accountSymbols, ...this.DEFAULT_TRADING_SYMBOLS]));
      return { 
        symbols: symbols.sort(),
        count: symbols.length,
      };
    } catch (error: any) {
      this.logger.warn(`Failed to fetch available symbols: ${error?.message}`);
      return {
        symbols: this.DEFAULT_TRADING_SYMBOLS.sort(),
        count: this.DEFAULT_TRADING_SYMBOLS.length,
        warning: 'Using default symbols - account symbols unavailable',
      };
    }
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
   * Get all orders (including filled) with comprehensive filters
   * @route GET /binance-testnet/orders/all
   * Query params:
   * - symbol: filter by symbol (e.g., BTCUSDT) - optional, if omitted aggregates across all trading symbols
   * - status: filter by order status (NEW, FILLED, PARTIALLY_FILLED, CANCELED, REJECTED, EXPIRED)
   * - side: filter by order side (BUY, SELL)
   * - type: filter by order type (MARKET, LIMIT, STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT, TAKE_PROFIT_LIMIT)
   * - orderId: get specific order by orderId
   * - startTime: filter orders from this timestamp (ms)
   * - endTime: filter orders until this timestamp (ms)
   * - limit: max number of orders (default 50, max 1000)
   */
  @Public()
  @Get('orders/all')
  async getAllOrders(
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
    @Query('side') side?: string,
    @Query('type') type?: string,
    @Query('orderId') orderId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: number,
  ) {
    const parsedLimit = limit ? Math.min(Number(limit), 1000) : 50;

    const filters = {
      status,
      side,
      type,
      orderId: orderId ? Number(orderId) : undefined,
      startTime: startTime ? Number(startTime) : undefined,
      endTime: endTime ? Number(endTime) : undefined,
      limit: parsedLimit,
    };

    try {
      // If a symbol is provided, query that symbol only
      if (symbol) {
        return await this.binanceTestnetService.getAllOrders({ symbol, ...filters });
      }

      // No symbol provided -> aggregate across all trading symbols for the account
      this.logger.debug('No symbol specified, aggregating orders across all trading symbols');

      // Try to get all symbols from account balances, fallback to default list
      let symbolList = this.DEFAULT_TRADING_SYMBOLS;
      try {
        const accountInfo = await this.binanceTestnetService.getAccountInfo();
        if (accountInfo?.balances && Array.isArray(accountInfo.balances)) {
          // Build symbol list from all non-zero balances (USDT pairs)
          const accountSymbols = new Set<string>();
          for (const balance of accountInfo.balances) {
            const asset = balance.asset;
            if (asset && asset !== 'USDT' && asset !== 'BUSD') {
              // Try common trading pairs
              accountSymbols.add(`${asset}USDT`);
            }
          }
          // Merge with default symbols to ensure coverage
          if (accountSymbols.size > 0) {
            symbolList = Array.from(new Set([...accountSymbols, ...this.DEFAULT_TRADING_SYMBOLS]));
            this.logger.debug(`Built symbol list from account balances: ${symbolList.length} symbols`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to fetch account info for symbol discovery: ${err?.message}, using default symbols`);
      }

      // When aggregating across multiple symbols, request more per symbol to ensure adequate coverage
      const perSymbolLimit = Math.ceil((parsedLimit * symbolList.length) / Math.max(symbolList.length, 1));

      // Parallel requests for better performance instead of sequential
      const requests = symbolList.map(s =>
        this.binanceTestnetService.getAllOrders({ 
          symbol: s, 
          ...filters,
          limit: perSymbolLimit,
        }).catch((err: any) => {
          // Log and continue on individual symbol failures (rate limits, invalid symbol, etc.)
          this.logger.warn(
            `Failed fetching orders for symbol ${s}: ${err?.message ?? 'Unknown error'}`,
          );
          return []; // Return empty array on error
        })
      );

      const responses = await Promise.all(requests);
      
      // Flatten all responses into a single array
      const aggregated = responses.flat();

      // Sort by order time (most recent first) and apply global limit
      const sorted = aggregated.sort(
        (a, b) => (b.timestamp ?? b.time ?? b.updateTime ?? 0) - (a.timestamp ?? a.time ?? a.updateTime ?? 0),
      );

      const result = sorted.slice(0, parsedLimit);

      this.logger.debug(`Aggregated ${result.length} orders across ${symbolList.length} symbols`);

      return { orders: result };
    } catch (error: any) {
      this.logger.error(`Failed to get all orders: ${error?.message ?? error}`, error?.stack);
      throw new BadRequestException(error?.message ?? 'Failed to fetch all orders');
    }
  }

  /**
   * Place an order
   * @route POST /binance-testnet/orders/place
   * @param dto order details (symbol, side, type, quantity, price)
   */
  @Public()
  @Post('orders/place')
  @HttpCode(HttpStatus.CREATED)
  async placeOrder(@Body() dto: PlaceTestnetOrderDto) {
    try {
      // Validate symbol format
      const symbol = dto.symbol?.trim().toUpperCase();
      if (!symbol || !/^[A-Z0-9]+$/.test(symbol)) {
        throw new BadRequestException(`Invalid symbol format: "${dto.symbol}". Expected format like XMRUSDT`);
      }

      // Log the order placement attempt
      this.logger.debug(`Attempting to place order: ${symbol} ${dto.side} ${dto.type} qty=${dto.quantity}`);

      const result = await this.binanceTestnetService.placeOrder(
        symbol,
        dto.side,
        dto.type,
        dto.quantity,
        dto.price,
      );

      this.logger.debug(`Order placed successfully: orderId=${result.orderId}`);
      return result;
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error?.message}`);
      
      // Provide helpful error messages
      if (error?.message?.includes('Invalid symbol')) {
        throw new BadRequestException(
          `Symbol "${dto.symbol}" is not available on Binance testnet. Call GET /binance-testnet/symbols to see available symbols.`
        );
      }
      
      throw new BadRequestException(error?.message ?? 'Failed to place order');
    }
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
