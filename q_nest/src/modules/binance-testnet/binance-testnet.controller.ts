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
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { BinanceTestnetService } from './services/binance-testnet.service';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { PlaceTestnetOrderDto } from './dto/place-testnet-order.dto';
import { TestnetOrderDto } from './dto/testnet-data.dto';
import { PrismaService } from '../../prisma/prisma.service';

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

  // Verified testnet symbols (as of Dec 2025) - these are guaranteed to exist
  private readonly DEFAULT_TRADING_SYMBOLS = [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'ADAUSDT',
    'DOGEUSDT',
    'SOLUSDT',
    'MATICUSDT',
    'LINKUSDT',
    'LTCUSDT',
    'DOTUSDT',
  ];

  constructor(
    private readonly binanceTestnetService: BinanceTestnetService,
    private readonly prisma: PrismaService,
  ) {}

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
      // First try to get actual available symbols from Binance testnet
      const exchangeInfo = await this.binanceTestnetService.getAvailableSymbols();
      if (exchangeInfo?.symbols?.length > 0) {
        return {
          symbols: exchangeInfo.symbols,
          count: exchangeInfo.symbols.length,
          source: 'binance_testnet',
        };
      }
      
      // Fallback to default list if exchange info fails
      this.logger.warn('Exchange info unavailable, using default symbol list');
      return {
        symbols: this.DEFAULT_TRADING_SYMBOLS.sort(),
        count: this.DEFAULT_TRADING_SYMBOLS.length,
        source: 'default',
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch available symbols: ${error?.message}`);
      return {
        symbols: this.DEFAULT_TRADING_SYMBOLS.sort(),
        count: this.DEFAULT_TRADING_SYMBOLS.length,
        source: 'default_fallback',
        error: error?.message,
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
   * Get orders from database (no Binance API calls)
   * @route GET /binance-testnet/orders/db
   */
  @Public()
  @Get('orders/db')
  async getOrdersFromDatabase(
    @Query('limit') limit?: number,
  ) {
    try {
      const parsedLimit = limit ? Math.min(Number(limit), 1000) : 100;
      const orders = await this.binanceTestnetService.getOrdersFromDatabase(parsedLimit);
      return { orders };
    } catch (error: any) {
      this.logger.error(`Failed to get orders from database: ${error?.message}`);
      throw new BadRequestException(error?.message ?? 'Failed to fetch orders');
    }
  }

  /**
   * Get orders from database synced with fresh Binance API data
   * @route GET /binance-testnet/orders/synced
   */
  @Public()
  @Get('orders/synced')
  async getSyncedOrders(
    @Query('limit') limit?: number,
  ) {
    try {
      const parsedLimit = limit ? Math.min(Number(limit), 1000) : 100;
      const orders = await this.binanceTestnetService.getSyncedOrdersFromDatabase(parsedLimit);
      return { orders };
    } catch (error: any) {
      this.logger.error(`Failed to get synced orders: ${error?.message}`);
      throw new BadRequestException(error?.message ?? 'Failed to fetch synced orders');
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

      // No symbol provided -> aggregate across trading symbols with actual balances OR recent orders
      this.logger.debug('No symbol specified, aggregating orders across symbols with balances and recent activity');

      // Query symbols that have non-zero balances OR recent orders
      let symbolList: string[] = [];
      const symbolSet = new Set<string>();
      
      try {
        const accountInfo = await this.binanceTestnetService.getAccountInfo();
        if (accountInfo?.balances && Array.isArray(accountInfo.balances)) {
          // Add symbols with non-zero balances
          for (const balance of accountInfo.balances) {
            const asset = balance.asset;
            const total = parseFloat(balance.free || '0') + parseFloat(balance.locked || '0');
            // Include assets with actual balance OR locked balance (open orders)
            if (asset && total > 0 && asset !== 'USDT' && asset !== 'BUSD') {
              symbolSet.add(`${asset}USDT`);
            }
          }
          this.logger.debug(`Found ${symbolSet.size} symbols with balances: ${Array.from(symbolSet).join(', ')}`);
        }
        
        symbolList = Array.from(symbolSet);
        
        // Don't add common pairs - only query symbols with actual balances to minimize API calls
        this.logger.debug(`Querying ${symbolList.length} symbols with balances`);
        
      } catch (err: any) {
        this.logger.warn(`Failed to fetch account info: ${err?.message}, skipping order fetch to avoid ban`);
        // Return empty to avoid more API calls when we can't even get account info
        return { orders: [] };
      }

      // When aggregating across multiple symbols, request more per symbol to ensure adequate coverage
      const perSymbolLimit = Math.ceil(parsedLimit / Math.max(symbolList.length, 1));

      // Process symbols in batches of 5 to avoid rate limiting
      // This prevents too many concurrent API calls
      const batchSize = 5;
      const allResponses: TestnetOrderDto[][] = [];
      
      for (let i = 0; i < symbolList.length; i += batchSize) {
        const batch = symbolList.slice(i, i + batchSize);
        this.logger.debug(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(symbolList.length / batchSize)}: ${batch.join(', ')}`);
        
        const batchStart = Date.now();
        const batchRequests = batch.map(s => {
          const symbolStart = Date.now();
          return this.binanceTestnetService.getAllOrders({ 
            symbol: s, 
            ...filters,
            limit: perSymbolLimit,
          }).then(result => {
            const symbolDuration = Date.now() - symbolStart;
            this.logger.debug(`Symbol ${s}: ${result.length} orders in ${symbolDuration}ms`);
            return result;
          }).catch((err: any) => {
            const symbolDuration = Date.now() - symbolStart;
            // Log and continue on individual symbol failures
            this.logger.warn(
              `Failed fetching orders for symbol ${s} (${symbolDuration}ms): ${err?.message ?? 'Unknown error'}`,
            );
            return []; // Return empty array on error
          });
        });
        
        const batchResponses = await Promise.all(batchRequests);
        allResponses.push(...batchResponses);
        
        const batchDuration = Date.now() - batchStart;
        this.logger.debug(`Batch ${Math.floor(i / batchSize) + 1} completed in ${batchDuration}ms`);
        
        // Small delay between batches to further reduce rate limit pressure
        if (i + batchSize < symbolList.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const responses = allResponses;
      
      // Flatten all responses into a single array
      const aggregated = responses.flat();

      // Sort by order timestamp (most recent first) and apply global limit
      const sorted = aggregated.sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
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
      
      // For MARKET orders, fetch the order details to get actual execution price
      if (result.type === 'MARKET' && result.status === 'FILLED' && !result.cumulativeQuoteAssetTransacted) {
        this.logger.debug(`Fetching order details for ${result.orderId} to get execution price...`);
        try {
          const orderDetails = await this.binanceTestnetService.getAllOrders({ 
            symbol, 
            orderId: result.orderId,
            limit: 1 
          });
          if (orderDetails?.length > 0 && orderDetails[0].cumulativeQuoteAssetTransacted) {
            result.cumulativeQuoteAssetTransacted = orderDetails[0].cumulativeQuoteAssetTransacted;
            result.price = orderDetails[0].cumulativeQuoteAssetTransacted / orderDetails[0].executedQuantity;
            this.logger.debug(`Updated order ${result.orderId} with execution price: ${result.price}`);
          }
        } catch (err: any) {
          this.logger.warn(`Failed to fetch order details: ${err.message}`);
        }
      }
      
      // Save order to database for persistence
      this.logger.log(`🔄 Attempting to save order ${result.orderId} to database...`);
      await this.binanceTestnetService.saveOrderToDatabase(result);
      this.logger.log(`💾 Database save completed for order ${result.orderId}`);
      
      // If this was a successful BUY order, automatically place OCO for risk management
      this.logger.log(`🔍 OCO Check - side: ${dto.side}, status: ${result.status}, executedQty: ${result.executedQuantity}`);
      if (dto.side === 'BUY' && result.status === 'FILLED' && result.executedQuantity > 0) {
        try {
          this.logger.log(`📊 Placing OCO order for BUY position: ${symbol}`);
          
          // Calculate SL/TP prices (default: -5% SL, +10% TP)
          const entryPrice = result.price || (result.cumulativeQuoteAssetTransacted / result.executedQuantity);
          this.logger.log(`💰 Entry price: ${entryPrice}, price: ${result.price}, cumulativeQuote: ${result.cumulativeQuoteAssetTransacted}`);
          const stopLossPercent = dto.stopLoss || 0.05; // 5% default
          const takeProfitPercent = dto.takeProfit || 0.10; // 10% default
          
          const stopLossPrice = entryPrice * (1 - stopLossPercent);
          const takeProfitPrice = entryPrice * (1 + takeProfitPercent);
          
          this.logger.log(
            `OCO Prices - Entry: ${entryPrice.toFixed(4)}, ` +
            `SL: ${stopLossPrice.toFixed(4)} (-${(stopLossPercent * 100).toFixed(1)}%), ` +
            `TP: ${takeProfitPrice.toFixed(4)} (+${(takeProfitPercent * 100).toFixed(1)}%)`
          );
          
          // Place OCO order
          this.logger.log(`🚀 Calling placeOcoOrder with: symbol=${symbol}, side=SELL, qty=${result.executedQuantity}, TP=${takeProfitPrice.toFixed(4)}, SL=${stopLossPrice.toFixed(4)}`);
          const ocoResult = await this.binanceTestnetService.placeOcoOrder(
            symbol,
            'SELL',
            result.executedQuantity,
            takeProfitPrice,
            stopLossPrice,
          );
          
          this.logger.log(`✅ OCO order placed successfully! orderListId=${ocoResult.orderListId}, orders=${JSON.stringify(ocoResult.orders)}`);
          
          // Find the saved order and update it with OCO metadata
          const savedOrders = await this.prisma.orders.findMany({
            where: {
              metadata: {
                path: ['binance_order_id'],
                equals: result.orderId,
              },
            },
            orderBy: {
              created_at: 'desc',
            },
            take: 1,
          });
          
          if (savedOrders.length > 0) {
            const savedOrder = savedOrders[0];
            await this.prisma.orders.update({
              where: { order_id: savedOrder.order_id },
              data: {
                metadata: {
                  ...(savedOrder.metadata as object),
                  oco_order_list_id: ocoResult.orderListId,
                  oco_take_profit_price: takeProfitPrice,
                  oco_stop_loss_price: stopLossPrice,
                  oco_orders: ocoResult.orders,
                },
              },
            });
            this.logger.log(`📝 Updated order metadata with OCO info`);
          }
          
          // Return result with OCO info
          return {
            ...result,
            ocoOrderListId: ocoResult.orderListId,
            ocoTakeProfitPrice: takeProfitPrice,
            ocoStopLossPrice: stopLossPrice,
          };
        } catch (ocoError: any) {
          // Log error but don't fail the main order - OCO is enhancement, not critical
          this.logger.error(`❌ Failed to place OCO order - Error: ${ocoError.message}`);
          this.logger.error(`Stack trace: ${ocoError.stack}`);
          if (ocoError.response) {
            this.logger.error(`API Response: ${JSON.stringify(ocoError.response)}`);
          }
        }
      }
      
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
   * Cancel all open orders for a symbol (PUBLIC for scripts)
   * @route DELETE /binance-testnet/orders/cancel-all/:symbol
   */
  @Public()
  @Delete('orders/cancel-all/:symbol')
  @HttpCode(HttpStatus.OK)
  async cancelAllOrdersForSymbol(@Param('symbol') symbol: string) {
    const openOrders = await this.binanceTestnetService.getOpenOrders();
    const symbolOrders = openOrders.filter((o: any) => o.symbol === symbol);
    
    const results = [];
    for (const order of symbolOrders) {
      try {
        const result = await this.binanceTestnetService.cancelOrder(symbol, order.orderId);
        results.push({ orderId: order.orderId, status: 'cancelled', result });
      } catch (error) {
        results.push({ orderId: order.orderId, status: 'failed', error: error?.message });
      }
    }
    
    return {
      symbol,
      cancelled: results.filter(r => r.status === 'cancelled').length,
      failed: results.filter(r => r.status === 'failed').length,
      details: results,
    };
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

  /**
   * Sync orders from Binance API into database
   * This imports existing Binance orders that weren't stored in DB
   * @route POST /binance-testnet/orders/sync
   */
  @Public()
  @Post('orders/sync')
  async syncOrdersFromBinance() {
    try {
      const result = await this.binanceTestnetService.syncOrdersFromBinanceToDatabase();
      return {
        success: true,
        message: `Synced ${result.synced} orders from Binance to database`,
        ...result,
      };
    } catch (error: any) {
      this.logger.error(`Failed to sync orders: ${error?.message}`);
      throw new BadRequestException(error?.message ?? 'Failed to sync orders');
    }
  }

  /**
   * Get trade history with realized P&L
   * @route GET /binance-testnet/trade-history
   */
  @Get('trade-history')
  async getTradeHistory(
    @Query('limit') limit?: number,
    @Query('startTime') startTime?: number,
    @Query('endTime') endTime?: number,
  ) {
    try {
      const trades = await this.binanceTestnetService.getTradeHistory({
        limit: limit ? parseInt(limit.toString()) : 200,
        startTime: startTime ? parseInt(startTime.toString()) : undefined,
        endTime: endTime ? parseInt(endTime.toString()) : undefined,
      });

      // Calculate summary statistics
      const totalTrades = trades.length;
      const profitableTrades = trades.filter(t => t.profitLoss > 0).length;
      const losingTrades = trades.filter(t => t.profitLoss < 0).length;
      const totalProfitLoss = trades.reduce((sum, t) => sum + t.profitLoss, 0);
      const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
      const avgProfit = totalTrades > 0 ? totalProfitLoss / totalTrades : 0;

      return {
        success: true,
        data: trades,
        summary: {
          totalTrades,
          profitableTrades,
          losingTrades,
          totalProfitLoss,
          winRate,
          avgProfit,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get trade history: ${error?.message}`);
      throw new BadRequestException(error?.message ?? 'Failed to get trade history');
    }
  }
}
