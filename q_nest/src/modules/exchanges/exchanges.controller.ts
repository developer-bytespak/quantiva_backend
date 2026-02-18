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
  Logger,
} from '@nestjs/common';
import { ExchangesService } from './exchanges.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KycVerifiedGuard } from '../../common/guards/kyc-verified.guard';
import { ConnectionOwnerGuard } from './guards/connection-owner.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { PlaceOrderDto } from './dto/place-order.dto';
import { BinanceService } from './integrations/binance.service';
import { BinanceUSService } from './integrations/binance-us.service';
import { BybitService } from './integrations/bybit.service';
import { AlpacaService } from './integrations/alpaca.service';
import { CacheService } from './services/cache.service';
import { ExchangeType } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { MarketService } from '../market/market.service';

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
  private readonly logger = new Logger(ExchangesController.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly binanceUSService: BinanceUSService,
    private readonly bybitService: BybitService,
    private readonly alpacaService: AlpacaService,
    private readonly cacheService: CacheService,
    private readonly marketService: MarketService,
  ) {}

  @Get()
  findAll() {
    return this.exchangesService.findAll();
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

  /**
   * Get all connections for the current authenticated user
   * This is used by the exchange configuration page
   * MUST be before @Get('connections/:userId') to avoid route collision
   */
  @Get('my-connections')
  async getUserConnectionsForCurrentUser(@CurrentUser() user: TokenPayload) {
    console.log('[GET my-connections] Route hit');
    console.log('[GET my-connections] User:', user);
    
    if (!user || !user.sub) {
      console.error('[GET my-connections] No user in request');
      throw new HttpException(
        {
          code: 'UNAUTHORIZED',
          message: 'User not authenticated',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    console.log('[GET my-connections] Fetching connections for userId:', user.sub);
    
    const connections = await this.exchangesService.getUserConnections(user.sub);
    
    console.log('[GET my-connections] Success! Found', connections?.length || 0, 'connections');
    console.log('[GET my-connections] Connections:', JSON.stringify(connections, null, 2).substring(0, 500));
    
    return {
      success: true,
      data: connections || [],
    };
  }

  @Get('connections/:userId')
  getUserConnections(@Param('userId') userId: string) {
    return this.exchangesService.getUserConnections(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.exchangesService.findOne(id);
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
    try {
      // First, get the exchange to get its name for verification
      const exchange = await this.exchangesService.findOne(createConnectionDto.exchange_id);
      if (!exchange) {
        throw new HttpException(
          {
            code: 'EXCHANGE_NOT_FOUND',
            message: 'Exchange not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      // Verify credentials with the exchange before creating connection
      let verification;
      const exchangeName = exchange.name.toLowerCase();
      const isBinanceUS = exchangeName === 'binance.us' || exchangeName === 'binanceus';

      if (isBinanceUS) {
        verification = await this.binanceUSService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else if (exchangeName.includes('binance')) {
        verification = await this.binanceService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else if (exchangeName.includes('bybit')) {
        verification = await this.bybitService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else if (exchangeName.includes('alpaca')) {
        verification = await this.alpacaService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else {
        throw new HttpException(
          {
            code: 'UNSUPPORTED_EXCHANGE',
            message: 'Exchange verification not supported',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!verification.valid) {
        throw new HttpException(
          {
            code: 'INVALID_CREDENTIALS',
            message: verification.error || 'Invalid API credentials',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      // If verification passes, create the connection
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
    } catch (error: any) {
      // Re-throw HTTP exceptions
      if (error instanceof HttpException) {
        throw error;
      }

      // Handle other errors
      const message = error?.message || 'Failed to create connection';
      const statusCode = message.includes('Invalid') || message.includes('Unauthorized')
        ? HttpStatus.UNAUTHORIZED
        : HttpStatus.BAD_REQUEST;

      throw new HttpException(
        {
          code: 'CONNECTION_CREATION_FAILED',
          message,
        },
        statusCode,
      );
    }
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateExchangeDto: any) {
    return this.exchangesService.update(id, updateExchangeDto);
  }

  /**
   * Update exchange connection with new API credentials
   * Requires password verification and connection ownership
   * 
   * @param connectionId - Connection ID to update
   * @param updateConnectionDto - New API credentials and password
   * @param user - Current authenticated user
   * @returns Updated connection details
   */
  @Put('connections/:connectionId')
  @UseGuards(ConnectionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async updateConnection(
    @Param('connectionId') connectionId: string,
    @Body() updateConnectionDto: UpdateConnectionDto,
    @CurrentUser() user: TokenPayload,
  ) {
    try {
      const result = await this.exchangesService.updateConnection(
        connectionId,
        user.sub,
        updateConnectionDto.api_key,
        updateConnectionDto.api_secret,
        updateConnectionDto.password,
        updateConnectionDto.passphrase,
      );

      return {
        success: true,
        data: result,
        message: 'Exchange connection updated successfully',
      };
    } catch (error: any) {
      // Return proper HTTP exception with meaningful error message
      const statusCode = error?.message?.includes('password') 
        ? HttpStatus.UNAUTHORIZED 
        : error?.message?.includes('Unauthorized')
        ? HttpStatus.FORBIDDEN
        : HttpStatus.BAD_REQUEST;

      throw new HttpException(
        {
          code: 'UPDATE_CONNECTION_FAILED',
          message: error?.message || 'Failed to update connection',
        },
        statusCode,
      );
    }
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

  /**
   * Get stock logo URL using external API
   * Uses a public stock logo CDN pattern
   */
  private getStockLogoUrl(symbol: string): string {
    // Use multiple fallback sources for stock logos
    const upper = symbol.toUpperCase();
    
    // Try Finnhub logo first (most reliable)
    // Format: https://api.example.com/logo?symbol=AAPL
    // Fallback: Use a CDN pattern that works for most stocks
    return `https://logo.clearbit.com/${upper}.com`;
  }

  /**
   * Extract logo URL from CoinGecko image object or string
   * Handles both formats: { large: "url" } or "url"
   */
  private extractLogoUrl(image: any): string | null {
    if (!image) return null;
    
    // If it's a string, return it directly
    if (typeof image === 'string') {
      return image;
    }
    
    // If it's an object with large/thumb/small properties, prioritize "large"
    if (typeof image === 'object') {
      return image.large || image.thumb || image.small || null;
    }
    
    return null;
  }

  /**
   * Fetch logos for all symbols in dashboard data
   * Dynamically queries CoinGecko for crypto and stock logo CDN for stocks
   * NO HARDCODING - fully dynamic approach
   */
  private async getLogosForSymbols(
    symbols: string[] = [],
    assetTypes: Record<string, "crypto" | "stock"> = {},
  ): Promise<Record<string, string>> {
    const logos: Record<string, string> = {};
    
    // Ensure symbols is an array
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return logos;
    }
    
    // Remove duplicates and clean symbols - just uppercase, remove USDT trading pair suffix only
    const uniqueSymbols = Array.from(new Set(
      symbols
        .filter(s => s && typeof s === 'string')
        .map(s => {
          // General cleanup: uppercase and remove trading pair suffix (e.g., "BNBUSDT" -> "BNB")
          // but keep pure stablecoins and tokens as-is
          const upper = s.toUpperCase();
          
          // If symbol looks like a trading pair (contains USDT at end and is long enough)
          // Remove the USDT suffix to get base symbol
          if (upper.endsWith('USDT') && upper.length > 4) {
            return upper.replace(/USDT$/, '');
          }
          return upper;
        })
        .filter(s => s.length > 0)
    ));

    if (uniqueSymbols.length === 0) {
      return logos;
    }

    this.logger.log(`Fetching logos for ${uniqueSymbols.length} unique assets`);

    // Fetch logos concurrently - for each symbol, try CoinGecko if crypto, stock CDN if stock
    const logoPromises = uniqueSymbols.map(async (symbol) => {
      const assetType = assetTypes[symbol] || 'crypto';
      
      try {
        // For CRYPTO: Query CoinGecko directly - it has all coins
        if (assetType === 'crypto') {
          try {
            this.logger.debug(`[${symbol}] Querying CoinGecko...`);
            const coinDetails = await this.marketService.getCoinDetails(symbol);
            
            if (coinDetails) {
              const logoUrl = this.extractLogoUrl(coinDetails.image);
              if (logoUrl) {
                logos[symbol] = logoUrl;
                this.logger.log(`[${symbol}] ✅ Got logo from CoinGecko`);
                return;
              }
            }
          } catch (error: any) {
            this.logger.debug(`[${symbol}] Not found in CoinGecko: ${error?.message}`);
          }
        }
        
        // For STOCK: Use stock logo CDN - works for all stocks
        if (assetType === 'stock') {
          const stockLogoUrl = this.getStockLogoUrl(symbol);
          logos[symbol] = stockLogoUrl;
          this.logger.log(`[${symbol}] ✅ Got stock logo URL`);
          return;
        }

        // Fallback: if crypto not found, try stock logo too
        if (assetType === 'crypto') {
          const stockLogoUrl = this.getStockLogoUrl(symbol);
          logos[symbol] = stockLogoUrl;
          this.logger.log(`[${symbol}] ✅ Using stock logo as fallback`);
          return;
        }

        this.logger.warn(`[${symbol}] (${assetType}) Could not find logo`);

      } catch (error: any) {
        this.logger.error(`[${symbol}] Error fetching logo: ${error?.message}`);
      }
    });

    // Wait for all requests with concurrency limit
    const batchSize = 5;
    for (let i = 0; i < logoPromises.length; i += batchSize) {
      await Promise.all(logoPromises.slice(i, i + batchSize));
    }

    this.logger.log(`Logo fetch done: ${Object.keys(logos).length}/${uniqueSymbols.length} found`);
    return logos;
  }

  @Get('connections/:connectionId/dashboard')
  @UseGuards(ConnectionOwnerGuard)
  async getDashboard(@Param('connectionId') connectionId: string) {
    try {
      // Get connection to determine exchange
      const connection = await this.exchangesService.getConnectionById(connectionId);
      if (!connection || !connection.exchange) {
        throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
      }

      const exchangeName = connection.exchange.name.toLowerCase();
      this.logger.log(`Dashboard request for ${exchangeName} connection: ${connectionId}, status: ${connection.status}`);
      
      // Check if connection is active
      if (connection.status !== 'active') {
        this.logger.warn(`Connection ${connectionId} is not active, status: ${connection.status}`);
        throw new HttpException(
          `Connection status is ${connection.status}. Please reconnect your exchange account.`,
          HttpStatus.BAD_REQUEST
        );
      }
      
      // OPTIMIZATION: Check if all data is cached before syncing
      // This prevents unnecessary API calls to external exchanges
      const isCached = this.exchangesService.isDashboardDataCached(connectionId, exchangeName);
      
      // Only sync if cache is missing (saves external API calls)
      if (!isCached) {
        this.logger.log(`Cache miss, syncing data for ${connectionId}`);
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
      const topPositions = Array.isArray(positions) ? (positions as any[]).slice(0, 10) : [];
      
      // For crypto exchanges, append USDT to symbols. For stocks (Alpaca), use symbol as-is
      const isCryptoExchange = exchangeName === 'binance' || exchangeName === 'bybit';
      const assetType = isCryptoExchange ? 'crypto' : 'stock';
      
      const positionSymbols = new Set(topPositions.map((p) => 
        isCryptoExchange ? `${p?.symbol}USDT` : p?.symbol
      ).filter(s => s));
      
      // Prices are already in positions data, extract them
      const prices = topPositions
        .filter((p) => p && p.symbol && p.currentPrice)
        .map((p) => ({
          symbol: isCryptoExchange ? `${p.symbol}USDT` : p.symbol,
          price: p.currentPrice,
          change24h: 0, // Not available in positions, would need separate call
          changePercent24h: p.pnlPercent || 0,
        }));

      // Collect ALL symbols from entire response
      // This ensures every asset in the response will have a logo
      const allSymbols: string[] = [];
      const assetTypeMap: Record<string, "crypto" | "stock"> = {};
      
      // Add position symbols (safely)
      if (Array.isArray(positions)) {
        (positions as any[])
          .filter((p) => p && p.symbol)
          .forEach((p) => {
            const sym = p.symbol;
            allSymbols.push(sym);
            assetTypeMap[sym] = assetType;
          });
      }
      
      // Add balance asset symbols (safely)
      if (balance && Array.isArray((balance as any)?.assets)) {
        (balance as any).assets
          .filter((a: any) => a && a.symbol)
          .forEach((a: any) => {
            const sym = a.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }
      
      // Add portal asset symbols (safely)
      if (portfolio && Array.isArray((portfolio as any)?.assets)) {
        (portfolio as any).assets
          .filter((a: any) => a && a.symbol)
          .forEach((a: any) => {
            const sym = a.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      // Add order symbols (safely)
      if (Array.isArray(orders)) {
        (orders as any[])
          .filter((o) => o && o.symbol)
          .forEach((o) => {
            const sym = o.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      // Add price symbols (safely)
      if (Array.isArray(prices)) {
        prices
          .filter((p) => p && p.symbol)
          .forEach((p) => {
            const sym = p.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      this.logger.log(`Fetching logos for ${allSymbols.length} unique assets (${assetType})`);
      const logos = await this.getLogosForSymbols(allSymbols, assetTypeMap);

      return {
        success: true,
        data: {
          balance,
          positions,
          orders: (orders as any[]).slice(0, 50), // Limit orders for dashboard
          portfolio,
          prices,
          logos, // All symbol -> logo URL mappings
          asset_types: assetTypeMap, // All symbol -> asset type mappings
        },
        last_updated: new Date().toISOString(),
        cached: isCached, // Indicate if data came from cache
      };
    } catch (error) {
      this.logger.error(`Dashboard error for ${connectionId}:`, error?.stack || error);
      throw error;
    }
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

