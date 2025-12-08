import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeType, ConnectionStatus } from '@prisma/client';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { BybitService } from './integrations/bybit.service';
import { CacheService } from './services/cache.service';
import { ConnectionNotFoundException } from './exceptions/binance.exceptions';
import {
  AccountBalanceDto,
  OrderDto,
  PositionDto,
  PortfolioDto,
  TickerPriceDto,
} from './dto/binance-data.dto';
import { OrderBookDto, RecentTradeDto } from './dto/orderbook.dto';

// Type for exchange services that implement common methods
type ExchangeService = BinanceService | BybitService;

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private binanceService: BinanceService,
    private bybitService: BybitService,
    private cacheService: CacheService,
  ) {}

  /**
   * Gets the appropriate exchange service based on exchange name
   */
  private getExchangeService(exchangeName: string): ExchangeService {
    const normalizedName = exchangeName.toLowerCase();
    
    if (normalizedName === 'binance') {
      return this.binanceService;
    } else if (normalizedName === 'bybit') {
      return this.bybitService;
    } else {
      this.logger.warn(`Unknown exchange: ${exchangeName}, defaulting to Binance`);
      return this.binanceService;
    }
  }

  async findAll() {
    return this.prisma.exchanges.findMany();
  }

  async findOne(id: string) {
    return this.prisma.exchanges.findUnique({
      where: { exchange_id: id },
      include: { connections: true },
    });
  }

  async findByName(name: string) {
    return this.prisma.exchanges.findUnique({
      where: { name },
    });
  }

  async create(data: {
    name: string;
    type: ExchangeType;
    supports_oauth?: boolean;
  }) {
    return this.prisma.exchanges.create({
      data,
    });
  }

  async update(id: string, data: {
    name?: string;
    type?: ExchangeType;
    supports_oauth?: boolean;
  }) {
    return this.prisma.exchanges.update({
      where: { exchange_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.exchanges.delete({
      where: { exchange_id: id },
    });
  }

  async getUserConnections(userId: string) {
    return this.prisma.user_exchange_connections.findMany({
      where: { user_id: userId },
      include: { exchange: true },
    });
  }

  async getActiveConnection(userId: string) {
    try {
      this.logger.debug(`Fetching active connection for user: ${userId}`);
      
      // First, find the connection without include to avoid potential relation issues
    const connection = await this.prisma.user_exchange_connections.findFirst({
      where: {
        user_id: userId,
        status: ConnectionStatus.active,
      },
      orderBy: {
        created_at: 'desc', // Get most recent active connection
      },
    });

    if (!connection) {
        this.logger.warn(`No active connection found for user: ${userId}`);
      throw new ConnectionNotFoundException('No active connection found');
    }

      this.logger.debug(`Found connection: ${connection.connection_id}, Exchange ID: ${connection.exchange_id}`);

      // Fetch exchange separately to avoid relation issues
      const exchange = await this.prisma.exchanges.findUnique({
        where: { exchange_id: connection.exchange_id },
      });
      
      if (!exchange) {
        this.logger.error(
          `Exchange ${connection.exchange_id} does not exist in database. Connection may be orphaned.`,
        );
        throw new ConnectionNotFoundException(
          `Exchange not found for this connection. The exchange record is missing. Please reconnect your account.`,
        );
      }

      this.logger.debug(`Found exchange: ${exchange.name} (${exchange.exchange_id})`);
      
      // Return the data in a clean format with proper serialization
    return {
      connection_id: connection.connection_id,
        exchange: {
          exchange_id: exchange.exchange_id,
          name: exchange.name,
          type: exchange.type,
          supports_oauth: exchange.supports_oauth,
          created_at: exchange.created_at?.toISOString() || null,
        },
      status: connection.status,
    };
    } catch (error: any) {
      // Re-throw known exceptions
      if (error instanceof ConnectionNotFoundException) {
        this.logger.warn(`ConnectionNotFoundException: ${error.message}`);
        throw error;
      }
      
      // Log unexpected errors with full details
      this.logger.error(`Unexpected error fetching active connection for user ${userId}:`, {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        code: error?.code,
      });
      
      // Re-throw as ConnectionNotFoundException to maintain consistent error format
      throw new ConnectionNotFoundException(
        `Failed to fetch active connection: ${error?.message || 'Unknown error'}`,
      );
    }
  }

  async getConnectionById(connectionId: string) {
    return this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });
  }

  async createConnection(data: {
    user_id: string;
    exchange_id: string;
    auth_type: string;
    api_key: string;
    api_secret: string;
    enable_trading: boolean;
  }) {
    // Encrypt API keys before storage
    const apiKeyEncrypted = this.encryptionService.encryptApiKey(data.api_key);
    const apiSecretEncrypted = this.encryptionService.encryptApiKey(data.api_secret);

    return this.prisma.user_exchange_connections.create({
      data: {
        user_id: data.user_id,
        exchange_id: data.exchange_id,
        auth_type: data.auth_type,
        api_key_encrypted: apiKeyEncrypted,
        api_secret_encrypted: apiSecretEncrypted,
        status: ConnectionStatus.pending,
        connection_metadata: {
          enable_trading: data.enable_trading,
        },
      },
      include: { exchange: true },
    });
  }

  /**
   * Verifies a connection by testing the API keys with the appropriate exchange
   */
  async verifyConnection(connectionId: string): Promise<{
    valid: boolean;
    status: ConnectionStatus;
    permissions: string[];
  }> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection) {
      throw new ConnectionNotFoundException();
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }

    if (!connection.exchange) {
      throw new ConnectionNotFoundException('Exchange not found for connection');
    }

    try {
      // Decrypt API keys
      const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
      const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

      // Get the appropriate exchange service
      const exchangeService = this.getExchangeService(connection.exchange.name);

      // Verify with the exchange
      const verification = await exchangeService.verifyApiKey(apiKey, apiSecret);

      // Update connection status and metadata
      await this.prisma.user_exchange_connections.update({
        where: { connection_id: connectionId },
        data: {
          status: verification.valid ? ConnectionStatus.active : ConnectionStatus.invalid,
          connection_metadata: {
            ...(connection.connection_metadata as object || {}),
            permissions: verification.permissions,
            accountType: verification.accountType,
            verified_at: new Date().toISOString(),
          },
          last_synced_at: new Date(),
        },
      });

      // Invalidate cache for this connection
      this.cacheService.invalidate(connectionId);

      return {
        valid: verification.valid,
        status: verification.valid ? ConnectionStatus.active : ConnectionStatus.invalid,
        permissions: verification.permissions,
      };
    } catch (error) {
      // Update connection status to invalid on error
      await this.prisma.user_exchange_connections.update({
        where: { connection_id: connectionId },
        data: {
          status: ConnectionStatus.invalid,
        },
      });

      throw error;
    }
  }

  /**
   * Syncs connection data from the exchange and caches it
   * Optimized to reduce redundant API calls
   */
  async syncConnectionData(connectionId: string): Promise<void> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || connection.status !== ConnectionStatus.active) {
      throw new ConnectionNotFoundException('Connection not found or not active');
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }

    if (!connection.exchange) {
      throw new ConnectionNotFoundException('Exchange not found for connection');
    }

    // Decrypt API keys
    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    // Get the appropriate exchange service
    const exchangeName = connection.exchange.name.toLowerCase();
    const isBinance = exchangeName === 'binance';
    const isBybit = exchangeName === 'bybit';

    try {
      let balance: AccountBalanceDto;
      let positions: PositionDto[];
      let orders: OrderDto[];
      let portfolio: PortfolioDto;

      if (isBinance) {
        // OPTIMIZATION: Fetch account info once and reuse it
        const accountInfo = await this.binanceService.getAccountInfo(apiKey, apiSecret);
        
        // Fetch balance, positions, and orders in parallel
        [balance, positions, orders] = await Promise.all([
          Promise.resolve(this.binanceService.mapAccountToBalance(accountInfo)),
          this.binanceService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
          this.binanceService.getOpenOrders(apiKey, apiSecret),
        ]);

        // Portfolio is calculated from positions
        portfolio = this.binanceService.calculatePortfolioFromPositions(positions);
      } else if (isBybit) {
        // OPTIMIZATION: Fetch account info once and reuse it
        const accountInfo = await this.bybitService.getAccountInfo(apiKey, apiSecret);
        
        // Fetch balance, positions, and orders in parallel
        [balance, positions, orders] = await Promise.all([
          Promise.resolve(this.bybitService.mapAccountToBalance(accountInfo)),
          this.bybitService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
          this.bybitService.getOpenOrders(apiKey, apiSecret),
        ]);

        // Portfolio is calculated from positions
        portfolio = this.bybitService.calculatePortfolioFromPositions(positions);
      } else {
        throw new Error(`Unsupported exchange: ${connection.exchange.name}`);
      }

      // Cache the data with exchange-specific keys
      this.cacheService.setCached(`${exchangeName}:${connectionId}:balance`, balance);
      this.cacheService.setCached(`${exchangeName}:${connectionId}:positions`, positions);
      this.cacheService.setCached(`${exchangeName}:${connectionId}:orders`, orders);
      this.cacheService.setCached(`${exchangeName}:${connectionId}:portfolio`, portfolio);

      // Update last_synced_at
      await this.prisma.user_exchange_connections.update({
        where: { connection_id: connectionId },
        data: {
          last_synced_at: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Failed to sync connection data for ${connectionId}`, error);
      throw error;
    }
  }

  /**
   * Checks if all dashboard data is cached (optimization to avoid unnecessary syncs)
   */
  isDashboardDataCached(connectionId: string, exchangeName: string): boolean {
    const requiredKeys = ['balance', 'positions', 'orders', 'portfolio'];
    return requiredKeys.every((dataType) => {
      const cacheKey = `${exchangeName}:${connectionId}:${dataType}`;
      return this.cacheService.getCached(cacheKey) !== null;
    });
  }

  /**
   * Gets connection data (from cache or fresh fetch)
   */
  async getConnectionData(
    connectionId: string,
    dataType: 'balance' | 'positions' | 'orders' | 'portfolio',
  ): Promise<AccountBalanceDto | PositionDto[] | OrderDto[] | PortfolioDto> {
    // Get connection to determine exchange name
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection or exchange not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:${dataType}`;
    
    // Try cache first
    const cached = this.cacheService.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - sync data
    await this.syncConnectionData(connectionId);

    // Return from cache after sync
    const fresh = this.cacheService.getCached(cacheKey);
    if (!fresh) {
      throw new Error(`Failed to fetch ${dataType} data`);
    }

    return fresh;
  }

  /**
   * Checks if user has trading permissions
   */
  async checkTradingPermission(connectionId: string): Promise<{
    canTrade: boolean;
    reason?: string;
  }> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection) {
      return { canTrade: false, reason: 'Connection not found' };
    }

    if (connection.status !== ConnectionStatus.active) {
      return { canTrade: false, reason: 'Connection is not active' };
    }

    const metadata = (connection.connection_metadata as any) || {};
    
    // Check if trading is enabled
    if (metadata.enable_trading !== true) {
      return { canTrade: false, reason: 'Trading is not enabled for this connection' };
    }

    // Check permissions for Binance
    const exchangeName = connection.exchange?.name.toLowerCase();
    if (exchangeName === 'binance') {
      const permissions = metadata.permissions || [];
      const accountType = metadata.accountType || '';
      
      // Log permissions for debugging
      this.logger.debug(`Checking Binance permissions for connection ${connectionId}:`, {
        permissions,
        accountType,
        enable_trading: metadata.enable_trading,
      });
      
      // Binance can return permissions in different formats:
      // 1. ['SPOT', 'MARGIN', 'FUTURES'] - standard format
      // 2. ['TRD_GRP_XXX'] - trading group format (newer format)
      // 3. Account type can be 'SPOT' which indicates spot trading capability
      
      // Check if account type indicates spot trading
      const isSpotAccount = accountType === 'SPOT' || accountType === 'MARGIN';
      
      // Check for standard permission names (case-insensitive)
      const hasSpotPermission = permissions.some(p => 
        p.toUpperCase().includes('SPOT') || p === 'SPOT'
      );
      const hasMarginPermission = permissions.some(p => 
        p.toUpperCase().includes('MARGIN') || p === 'MARGIN'
      );
      
      // Check for trading group format (TRD_GRP_XXX indicates trading is enabled)
      const hasTradingGroup = permissions.some(p => 
        p.toUpperCase().startsWith('TRD_GRP_')
      );
      
      // If enable_trading is true, account is active, and we have any indication of trading capability
      // OR if we have a trading group (which means trading is enabled)
      // OR if account type is SPOT/MARGIN
      if (hasSpotPermission || hasMarginPermission || hasTradingGroup || isSpotAccount) {
        // Trading is allowed
        return { canTrade: true };
      }
      
      // If none of the above, trading is not allowed
      return { 
        canTrade: false, 
        reason: `API key does not have trading permissions. Current permissions: ${permissions.join(', ') || 'none'}, Account Type: ${accountType || 'unknown'}. Please ensure Spot Trading and/or Margin Trading is enabled in your Binance API key settings, then re-verify your connection.` 
      };
    }

    // For Bybit, we assume if enable_trading is true and connection is active, trading is allowed
    // Bybit doesn't provide detailed permissions in the verification endpoint

    return { canTrade: true };
  }

  /**
   * Places an order through the connected exchange
   */
  async placeOrder(
    connectionId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    price?: number,
  ): Promise<OrderDto> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }

    // Decrypt API keys
    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    // Get the appropriate exchange service
    const exchangeService = this.getExchangeService(connection.exchange.name);

    // Place order
    if (exchangeService instanceof BinanceService) {
      return this.binanceService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else if (exchangeService instanceof BybitService) {
      return this.bybitService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else {
      throw new Error(`Unsupported exchange: ${connection.exchange.name}`);
    }
  }

  async updateConnection(id: string, data: {
    auth_type?: string;
    api_key_encrypted?: string;
    api_secret_encrypted?: string;
    oauth_access_token?: string;
    oauth_refresh_token?: string;
    permissions?: any;
    status?: ConnectionStatus;
    connection_metadata?: any;
  }) {
    // Invalidate cache on update
    this.cacheService.invalidate(id);

    return this.prisma.user_exchange_connections.update({
      where: { connection_id: id },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });
  }

  async deleteConnection(id: string) {
    return this.prisma.user_exchange_connections.delete({
      where: { connection_id: id },
    });
  }

  /**
   * Gets order book for a symbol
   */
  async getOrderBook(connectionId: string, symbol: string, limit: number = 20): Promise<OrderBookDto> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    
    if (exchangeName === 'binance') {
      return this.binanceService.getOrderBook(symbol, limit);
    } else if (exchangeName === 'bybit') {
      return this.bybitService.getOrderBook(symbol, limit);
    } else {
      throw new Error(`Unsupported exchange: ${connection.exchange.name}`);
    }
  }

  /**
   * Gets recent trades for a symbol
   */
  async getRecentTrades(connectionId: string, symbol: string, limit: number = 50): Promise<RecentTradeDto[]> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    
    if (exchangeName === 'binance') {
      return this.binanceService.getRecentTrades(symbol, limit);
    } else if (exchangeName === 'bybit') {
      return this.bybitService.getRecentTrades(symbol, limit);
    } else {
      throw new Error(`Unsupported exchange: ${connection.exchange.name}`);
    }
  }
}

