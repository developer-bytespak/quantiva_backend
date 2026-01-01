import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ExchangesService } from './exchanges.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KycVerifiedGuard } from '../../common/guards/kyc-verified.guard';
import { ConnectionOwnerGuard } from './guards/connection-owner.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { PlaceOrderDto } from './dto/place-order.dto';
import { BinanceService } from './integrations/binance.service';
import { BybitService } from './integrations/bybit.service';
import { CacheService } from './services/cache.service';
import { ExchangeType } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

/**
 * Exchanges Controller
 * 
 * Handles exchange connections and exchange API integration (Binance, Bybit).
 * All endpoints require JWT authentication.
 * 
 * @api {post} /exchanges/connections Create Exchange Connection
 * @api {post} /exchanges/connections/:connectionId/verify Verify API Keys
 * @api {get} /exchanges/connections/:connectionId/balance Get Account Balance
 * @api {get} /exchanges/connections/:connectionId/positions Get Positions
 * @api {get} /exchanges/connections/:connectionId/orders Get Orders
 * @api {get} /exchanges/connections/:connectionId/portfolio Get Portfolio
 * @api {get} /exchanges/connections/:connectionId/ticker/:symbol Get Ticker Price
 * @api {get} /exchanges/connections/:connectionId/dashboard Get Dashboard Data (Combined)
 */
@Controller('exchanges')
@UseGuards(JwtAuthGuard)
export class ExchangesController {
  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly bybitService: BybitService,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  findAll() {
    return this.exchangesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.exchangesService.findOne(id);
  }

  @Get('connections/active')
  async getActiveConnection(@CurrentUser() user: TokenPayload) {
    try {
      if (!user || !user.sub) {
        throw new HttpException(
          {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const connection = await this.exchangesService.getActiveConnection(user.sub);
      
      // Ensure the response is properly serialized
      return {
        success: true,
        data: connection,
      };
    } catch (error: any) {
      // Log the full error for debugging
      console.error('Error in getActiveConnection controller:', {
        message: error?.message,
        stack: error?.stack,
        statusCode: error?.statusCode,
        response: error?.response,
        name: error?.name,
        user: user?.sub,
      });

      // Re-throw HTTP exceptions as-is (ConnectionNotFoundException extends HttpException)
      if (error instanceof HttpException || error?.statusCode) {
        throw error;
      }
      
      // For any other unexpected errors, return a proper HTTP exception
      throw new HttpException(
        {
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message || 'Failed to fetch active connection',
          details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('connections/:userId')
  getUserConnections(@Param('userId') userId: string) {
    return this.exchangesService.getUserConnections(userId);
  }

  @Post()
  async create(@Body() createExchangeDto: { name: string; type: ExchangeType; supports_oauth?: boolean }) {
    // Check if exchange already exists
    const existing = await this.exchangesService.findByName(createExchangeDto.name);
    if (existing) {
      return existing;
    }
    
    return this.exchangesService.create(createExchangeDto);
  }

  /**
   * Create a new exchange connection
   * Requires KYC verification
   * 
   * @param createConnectionDto - Connection data including encrypted API keys
   * @param user - Current authenticated user
   * @returns Connection ID and status
   */
  @Post('connections')
  // @UseGuards(KycVerifiedGuard)
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Body() createConnectionDto: CreateConnectionDto,
    @CurrentUser() user: TokenPayload,
  ) {
    const connection = await this.exchangesService.createConnection({
      user_id: user.sub,
      exchange_id: createConnectionDto.exchange_id,
      auth_type: 'api_key',
      api_key: createConnectionDto.api_key,
      api_secret: createConnectionDto.api_secret,
      enable_trading: createConnectionDto.enable_trading,
    });

    return {
      success: true,
      data: {
        connection_id: connection.connection_id,
        status: connection.status,
      },
      message: 'Connection created successfully. Please verify your API keys.',
    };
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateExchangeDto: any) {
    return this.exchangesService.update(id, updateExchangeDto);
  }

  @Put('connections/:id')
  updateConnection(@Param('id') id: string, @Body() updateConnectionDto: any) {
    return this.exchangesService.updateConnection(id, updateConnectionDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.exchangesService.delete(id);
  }

  @Delete('connections/:id')
  @UseGuards(ConnectionOwnerGuard)
  async removeConnection(@Param('id') id: string) {
    // Invalidate cache before deletion
    this.cacheService.invalidate(id);
    await this.exchangesService.deleteConnection(id);
    return {
      success: true,
      message: 'Connection deleted successfully',
    };
  }

  /**
   * Verify API keys with Binance
   * 
   * @param connectionId - Connection ID to verify
   * @returns Verification result with permissions
   */
  @Post('connections/:connectionId/verify')
  @UseGuards(ConnectionOwnerGuard)
  async verifyConnection(@Param('connectionId') connectionId: string) {
    const result = await this.exchangesService.verifyConnection(connectionId);
    return {
      success: result.valid,
      data: {
        valid: result.valid,
        status: result.status,
        permissions: result.permissions,
      },
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/balance')
  @UseGuards(ConnectionOwnerGuard)
  async getBalance(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:balance`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const balance = await this.exchangesService.getConnectionData(connectionId, 'balance');
    return {
      success: true,
      data: balance,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/profile')
  @UseGuards(ConnectionOwnerGuard)
  async getConnectionProfile(@Param('connectionId') connectionId: string) {
    try {
      const profile = await this.exchangesService.getConnectionProfile(connectionId);
      return {
        success: true,
        data: profile,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error('Error fetching connection profile:', error?.message || error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          code: 'PROFILE_FETCH_FAILED',
          message: error?.message || 'Failed to fetch connection profile',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('connections/:connectionId/positions')
  @UseGuards(ConnectionOwnerGuard)
  async getPositions(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:positions`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const positions = await this.exchangesService.getConnectionData(connectionId, 'positions');
    return {
      success: true,
      data: positions,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/orders')
  @UseGuards(ConnectionOwnerGuard)
  async getOrders(
    @Param('connectionId') connectionId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:orders`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached && (!status || status === 'open')) {
      let orders = cached as any[];
      if (status === 'open') {
        orders = orders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
      }
      if (limit) {
        orders = orders.slice(0, parseInt(limit, 10));
      }
      return {
        success: true,
        data: orders,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const orders = await this.exchangesService.getConnectionData(connectionId, 'orders');
    let filteredOrders = orders as any[];
    
    if (status === 'open') {
      filteredOrders = filteredOrders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
    }
    if (limit) {
      filteredOrders = filteredOrders.slice(0, parseInt(limit, 10));
    }

    return {
      success: true,
      data: filteredOrders,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/portfolio')
  @UseGuards(ConnectionOwnerGuard)
  async getPortfolio(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:portfolio`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const portfolio = await this.exchangesService.getConnectionData(connectionId, 'portfolio');
    return {
      success: true,
      data: portfolio,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/ticker/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getTickerPrice(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    // Ticker prices are public, no need for API keys
    // Route to the correct exchange service
    const exchangeName = connection.exchange.name.toLowerCase();
    let prices;
    
    if (exchangeName === 'bybit') {
      prices = await this.bybitService.getTickerPrices([symbol]);
    } else {
      // Default to Binance
      prices = await this.binanceService.getTickerPrices([symbol]);
    }
    
    const price = prices[0] || null;

    return {
      success: true,
      data: price,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/candles/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getCandlestickData(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('interval') interval: string = '1h',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    // Candlestick data is public, no need for API keys
    const exchangeName = connection.exchange.name.toLowerCase();
    const limitNum = parseInt(limit, 10) || 100;
    const startTimeNum = startTime ? parseInt(startTime, 10) : undefined;
    const endTimeNum = endTime ? parseInt(endTime, 10) : undefined;

    let candles;
    if (exchangeName === 'bybit') {
      candles = await this.bybitService.getCandlestickData(symbol, interval, limitNum, startTimeNum, endTimeNum);
    } else {
      // Default to Binance
      candles = await this.binanceService.getCandlestickData(symbol, interval, limitNum, startTimeNum, endTimeNum);
    }

    return {
      success: true,
      data: candles,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/trading-permissions')
  @UseGuards(ConnectionOwnerGuard)
  async getTradingPermissions(@Param('connectionId') connectionId: string) {
    const permissionCheck = await this.exchangesService.checkTradingPermission(connectionId);
    return {
      success: true,
      data: permissionCheck,
      last_updated: new Date().toISOString(),
    };
  }

  @Post('connections/:connectionId/orders/place')
  @UseGuards(ConnectionOwnerGuard)
  async placeOrder(
    @Param('connectionId') connectionId: string,
    @Body() placeOrderDto: PlaceOrderDto,
  ) {
    // Check trading permissions
    const permissionCheck = await this.exchangesService.checkTradingPermission(connectionId);
    if (!permissionCheck.canTrade) {
      throw new ForbiddenException(permissionCheck.reason || 'Trading is not allowed');
    }

    // Place order through service
    const order = await this.exchangesService.placeOrder(
      connectionId,
      placeOrderDto.symbol,
      placeOrderDto.side,
      placeOrderDto.type,
      placeOrderDto.quantity,
      placeOrderDto.price,
    );

    return {
      success: true,
      data: order,
      message: 'Order placed successfully',
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/coin/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getCoinDetail(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    const exchangeName = connection.exchange.name.toLowerCase();

    // Fetch ticker price (24h stats)
    let ticker;
    if (exchangeName === 'bybit') {
      const tickers = await this.bybitService.getTickerPrices([symbol]);
      ticker = tickers[0] || null;
    } else {
      const tickers = await this.binanceService.getTickerPrices([symbol]);
      ticker = tickers[0] || null;
    }

    // Fetch current candlestick data (default 1d interval, 100 candles)
    let candles;
    if (exchangeName === 'bybit') {
      candles = await this.bybitService.getCandlestickData(symbol, '1d', 100);
    } else {
      candles = await this.binanceService.getCandlestickData(symbol, '1d', 100);
    }

    // Fetch account balance for quote currency (USDT)
    const balance = await this.exchangesService.getConnectionData(connectionId, 'balance') as any;
    const quoteCurrency = 'USDT';
    const quoteBalance = balance.assets?.find((a: any) => a.symbol === quoteCurrency) || null;
    const availableBalance = quoteBalance ? parseFloat(quoteBalance.free || '0') : 0;

    // Extract 24h high/low from ticker if available (Binance provides this, Bybit may not)
    let high24h = 0;
    let low24h = 0;
    let volume24h = 0;

    if (ticker) {
      // For Binance, we'd need to fetch full ticker data with 24h stats
      // For now, we'll use the candlestick data to estimate
      if (candles && candles.length > 0) {
        const recentCandles = candles.slice(-24); // Last 24 hours worth of 1h candles
        high24h = Math.max(...recentCandles.map(c => c.high));
        low24h = Math.min(...recentCandles.map(c => c.low));
        volume24h = recentCandles.reduce((sum, c) => sum + c.volume, 0);
      }
    }

    return {
      success: true,
      data: {
        symbol,
        tradingPair: symbol,
        currentPrice: ticker?.price || 0,
        change24h: ticker?.change24h || 0,
        changePercent24h: ticker?.changePercent24h || 0,
        high24h,
        low24h,
        volume24h,
        availableBalance,
        quoteCurrency,
        candles: candles.slice(0, 100), // Return last 100 candles
      },
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Get combined dashboard data (optimized endpoint)
   * Returns balance, positions, orders, portfolio, and prices in a single call
   * 
   * @param connectionId - Connection ID
   * @returns Combined dashboard data
   */
  @Get('connections/:connectionId/dashboard')
  @UseGuards(ConnectionOwnerGuard)
  async getDashboard(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    
    // OPTIMIZATION: Check if all data is cached before syncing
    // This prevents unnecessary API calls to external exchanges
    const isCached = this.exchangesService.isDashboardDataCached(connectionId, exchangeName);
    
    // Only sync if cache is missing (saves external API calls)
    if (!isCached) {
      await this.exchangesService.syncConnectionData(connectionId);
    }

    const [balance, positions, orders, portfolio] = await Promise.all([
      this.exchangesService.getConnectionData(connectionId, 'balance'),
      this.exchangesService.getConnectionData(connectionId, 'positions'),
      this.exchangesService.getConnectionData(connectionId, 'orders'),
      this.exchangesService.getConnectionData(connectionId, 'portfolio'),
    ]);

    // OPTIMIZATION: Reuse prices from positions (already fetched during sync)
    // Only fetch additional prices if needed for symbols not in positions
    const topPositions = (positions as any[]).slice(0, 10);
    const positionSymbols = new Set(topPositions.map((p) => `${p.symbol}USDT`));
    
    // Prices are already in positions data, extract them
    const prices = topPositions.map((p) => ({
      symbol: `${p.symbol}USDT`,
      price: p.currentPrice,
      change24h: 0, // Not available in positions, would need separate call
      changePercent24h: p.pnlPercent || 0,
    }));

    return {
      success: true,
      data: {
        balance,
        positions,
        orders: (orders as any[]).slice(0, 50), // Limit orders for dashboard
        portfolio,
        prices,
      },
      last_updated: new Date().toISOString(),
      cached: isCached, // Indicate if data came from cache
    };
  }

  @Get('connections/:connectionId/orderbook/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getOrderBook(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('limit') limit: string = '20',
  ) {
    const orderBook = await this.exchangesService.getOrderBook(
      connectionId,
      symbol,
      parseInt(limit, 10),
    );

    return {
      success: true,
      data: orderBook,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/trades/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getRecentTrades(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('limit') limit: string = '50',
  ) {
    const trades = await this.exchangesService.getRecentTrades(
      connectionId,
      symbol,
      parseInt(limit, 10),
    );

    return {
      success: true,
      data: trades,
      last_updated: new Date().toISOString(),
    };
  }
}

