import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeType, ConnectionStatus } from '@prisma/client';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { BybitService } from './integrations/bybit.service';
import { AlpacaService } from './integrations/alpaca.service';
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
// Type for exchange services that implement common methods
type ExchangeService = BinanceService | BybitService | AlpacaService;

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private binanceService: BinanceService,
    private bybitService: BybitService,
    private alpacaService: AlpacaService,
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
    } else if (normalizedName === 'alpaca') {
      return this.alpacaService as unknown as ExchangeService;
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
    try {
      this.logger.debug(`[getUserConnections] Fetching connections for user: ${userId}`);
      
      const rawConnections = await this.prisma.user_exchange_connections.findMany({
        where: { user_id: userId },
        include: { exchange: true },
      });

      this.logger.debug(`[getUserConnections] Found ${rawConnections.length} connections for user: ${userId}`);
      
      // Serialize to plain objects with ISO string dates
      const connections = rawConnections.map(conn => {
        return {
          connection_id: conn.connection_id,
          user_id: conn.user_id,
          exchange_id: conn.exchange_id,
          auth_type: conn.auth_type,
          status: conn.status,
          connection_metadata: conn.connection_metadata,
          last_synced_at: conn.last_synced_at ? new Date(conn.last_synced_at).toISOString() : null,
          created_at: conn.created_at ? new Date(conn.created_at).toISOString() : null,
          updated_at: conn.updated_at ? new Date(conn.updated_at).toISOString() : null,
          exchange: conn.exchange ? {
            exchange_id: conn.exchange.exchange_id,
            name: conn.exchange.name,
            type: conn.exchange.type,
            supports_oauth: conn.exchange.supports_oauth,
            created_at: conn.exchange.created_at ? new Date(conn.exchange.created_at).toISOString() : null,
          } : null,
        };
      });

      return connections;
    } catch (error: any) {
      this.logger.error(`[getUserConnections] Error fetching connections for user ${userId}:`, {
        message: error?.message,
        code: error?.code,
        stack: error?.stack,
      });
      throw error;
    }
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

  /**
   * Returns decrypted API credentials for a connection. Call only after connection ownership is verified (e.g. ConnectionOwnerGuard).
   */
  async getDecryptedCredentials(connectionId: string): Promise<{ apiKey: string; apiSecret: string }> {
    const connection = await this.getConnectionById(connectionId);
    if (!connection) {
      throw new ConnectionNotFoundException('Connection not found');
    }
    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }
    return {
      apiKey: this.encryptionService.decryptApiKey(connection.api_key_encrypted),
      apiSecret: this.encryptionService.decryptApiKey(connection.api_secret_encrypted),
    };
  }

  /**
   * Returns account/profile information for a connection by calling the underlying exchange integration.
   */
  async getConnectionProfile(connectionId: string): Promise<any> {
    const connection = await this.getConnectionById(connectionId);

    if (!connection) {
      throw new ConnectionNotFoundException('Connection not found');
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

    // Choose correct exchange integration
    const exchangeService = this.getExchangeService(connection.exchange.name);

    // Ensure integration provides account/profile info
    if (typeof (exchangeService as any).getAccountInfo === 'function') {
      const profile = await (exchangeService as any).getAccountInfo(apiKey, apiSecret);
      return profile;
    }

    throw new Error(`Unsupported exchange for profile: ${connection.exchange.name}`);
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

    // Check if there's an existing connection for this user and exchange
    const existingConnection = await this.prisma.user_exchange_connections.findFirst({
      where: {
        user_id: data.user_id,
        exchange_id: data.exchange_id,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    // If there's an existing connection (regardless of status), update it with new credentials
    if (existingConnection) {
      this.logger.log(`Updating existing connection ${existingConnection.connection_id} (status: ${existingConnection.status}) with new credentials (key starts with: ${data.api_key.substring(0, 2)}...)`);
      
      // First, mark all other connections for this exchange as invalid to avoid conflicts
      await this.prisma.user_exchange_connections.updateMany({
        where: {
          user_id: data.user_id,
          exchange_id: data.exchange_id,
          connection_id: {
            not: existingConnection.connection_id,
          },
        },
        data: {
          status: ConnectionStatus.invalid,
        },
      });
      
      return this.prisma.user_exchange_connections.update({
        where: { connection_id: existingConnection.connection_id },
        data: {
          api_key_encrypted: apiKeyEncrypted,
          api_secret_encrypted: apiSecretEncrypted,
          status: ConnectionStatus.active, // Set to active since keys are pre-verified
          connection_metadata: {
            enable_trading: data.enable_trading,
            verified_at: new Date().toISOString(),
          },
          updated_at: new Date(),
        },
        include: { exchange: true },
      });
    }

    // Create new connection if none exists (and mark any orphaned ones as invalid)
    this.logger.log(`Creating new connection for user ${data.user_id} and exchange ${data.exchange_id}`);
    
    // Mark any old connections for this exchange as invalid
    await this.prisma.user_exchange_connections.updateMany({
      where: {
        user_id: data.user_id,
        exchange_id: data.exchange_id,
      },
      data: {
        status: ConnectionStatus.invalid,
      },
    });
    
    return this.prisma.user_exchange_connections.create({
      data: {
        user_id: data.user_id,
        exchange_id: data.exchange_id,
        auth_type: data.auth_type,
        api_key_encrypted: apiKeyEncrypted,
        api_secret_encrypted: apiSecretEncrypted,
        status: ConnectionStatus.active, // Set to active since keys are pre-verified
        connection_metadata: {
          enable_trading: data.enable_trading,
          verified_at: new Date().toISOString(),
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
      this.logger.debug(`Verifying connection ${connectionId} for exchange: ${connection.exchange.name}`);
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

    if (!connection) {
      this.logger.error(`Connection ${connectionId} not found in database`);
      throw new ConnectionNotFoundException('Connection not found');
    }

    if (connection.status !== ConnectionStatus.active) {
      this.logger.error(`Connection ${connectionId} has status: ${connection.status}, expected: active`);
      throw new ConnectionNotFoundException(`Connection status is ${connection.status}. Please reconnect your exchange account.`);
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
    const isAlpaca = exchangeName === 'alpaca';

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
      } else if (isAlpaca) {
        // Alpaca: fetch account info, positions and orders
        console.log(`[SYNC] Syncing Alpaca connection ${connectionId}, API Key starts with: ${apiKey.substring(0, 2)}...`);
        const accountInfo = await this.alpacaService.getAccountInfo(apiKey, apiSecret);
        const positionsRaw = await this.alpacaService.getPositions(apiKey, apiSecret);
        const ordersRaw = await this.alpacaService.getOrders(apiKey, apiSecret);

        // Map positions
        positions = (positionsRaw || []).map((p: any) => {
          const qty = parseFloat(p.qty || p.quantity || '0');
          const entryPrice = parseFloat(p.avg_entry_price || p.avg_entry_value || '0');
          const currentPrice = parseFloat(p.current_price || (p.market_value && qty ? (parseFloat(p.market_value) / qty).toString() : '0')) || 0;
          const unrealizedPnl = (currentPrice - entryPrice) * qty;
          const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

          return {
            symbol: p.symbol,
            quantity: qty,
            entryPrice,
            currentPrice,
            unrealizedPnl,
            pnlPercent,
          } as PositionDto;
        });

        // Map balance: portfolio_value, cash, buying_power; include USD for buying power (e.g. stock panel)
        const totalValueUSD = parseFloat(accountInfo.portfolio_value || accountInfo.equity || '0') || 0;
        const buyingPower = parseFloat(accountInfo.buying_power || accountInfo.cash || '0') || 0;
        const cash = parseFloat(accountInfo.cash || '0') || 0;
        const assets = (positions || []).map((pos) => ({
          symbol: pos.symbol,
          free: pos.quantity.toString(),
          locked: '0',
          total: pos.quantity.toString(),
        }));
        // Add USD so frontend can show buying power (e.g. StockTradingPanel)
        assets.unshift({
          symbol: 'USD',
          free: buyingPower.toString(),
          locked: '0',
          total: cash.toString(),
        });

        balance = {
          assets,
          totalValueUSD,
          buyingPower,
        } as AccountBalanceDto;

        // Map orders
        orders = (ordersRaw || []).map((o: any) => ({
          orderId: o.id || o.client_order_id || '',
          symbol: o.symbol || o.asset_symbol || '',
          side: (o.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
          type: o.type || o.order_type || '',
          quantity: parseFloat(o.qty || o.quantity || '0'),
          price: parseFloat(o.limit_price || o.price || '0') || 0,
          status: o.status || '',
          time: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
        })) as OrderDto[];

        // Portfolio: simple aggregation from positions
        const totalCost = positions.reduce((acc, p) => acc + (p.entryPrice || 0) * (p.quantity || 0), 0);
        const totalValue = positions.reduce((acc, p) => acc + (p.currentPrice || 0) * (p.quantity || 0), 0) + (parseFloat(accountInfo.cash || '0') || 0);
        const totalPnl = totalValue - totalCost;
        const pnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

        portfolio = {
          totalValue,
          totalCost,
          totalPnl,
          pnlPercent,
          assets: positions.map((p) => ({
            symbol: p.symbol,
            quantity: p.quantity,
            value: (p.currentPrice || 0) * p.quantity,
            cost: (p.entryPrice || 0) * p.quantity,
            pnl: ((p.currentPrice || 0) - (p.entryPrice || 0)) * p.quantity,
            pnlPercent: p.entryPrice > 0 ? (((p.currentPrice || 0) - p.entryPrice) / p.entryPrice) * 100 : 0,
          })),
        } as PortfolioDto;
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
      console.error(`[SYNC] Failed to sync connection data for ${connectionId}:`, error?.message);
      this.logger.error(`Failed to sync connection data for ${connectionId}`, error);
      
      // Check if it's an authentication error - log but don't mark as invalid for now
      if (error?.response?.status === 401 || error?.status === 401) {
        console.error(`[SYNC] 401 Unauthorized error - API credentials may be invalid`);
        // Temporarily disabled: Don't mark as invalid to allow retry
        // await this.prisma.user_exchange_connections.update({
        //   where: { connection_id: connectionId },
        //   data: { status: ConnectionStatus.invalid },
        // }).catch(err => this.logger.error('Failed to update connection status', err));
        
        throw new Error('API credentials are invalid or expired. Please check your Alpaca API keys.');
      }
      
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

    // Special-case: if caller only asked for balance, fetch account snapshot only
    if (dataType === 'balance') {
      try {
        // Decrypt API keys
        const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
        const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

        // Use the specific exchange integration to fetch balance-only (fast single call)
        const exchangeService = this.getExchangeService(exchangeName) as any;
        if (typeof exchangeService.getAccountBalance === 'function') {
          const balance = await exchangeService.getAccountBalance(apiKey, apiSecret);

          // Cache and return balance only (avoid fetching orders by default)
          this.cacheService.setCached(cacheKey, balance);
          return balance;
        }
      } catch (error) {
        // If balance-only fetch fails for any reason, fall back to full sync
        this.logger.warn(`Balance-only fetch failed for ${connectionId}, falling back to full sync: ${error?.message ?? error}`);
      }
    }

    // Cache miss or not a balance-only request - sync all data (legacy behavior)
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

    // Place order (Alpaca: paper vs live is determined by the user's key prefix PK vs AK)
    if (exchangeService instanceof BinanceService) {
      return this.binanceService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else if (exchangeService instanceof BybitService) {
      return this.bybitService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else if (exchangeService instanceof AlpacaService) {
      return this.alpacaService.placeOrder(
        symbol,
        side,
        type,
        quantity,
        price,
        apiKey,
        apiSecret,
      );
    } else {
      throw new Error(`Unsupported exchange: ${connection.exchange.name}`);
    }
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

  /**
   * Verifies that the user owns a valid exchange account with the provided credentials
   * This method tests the API credentials against the actual exchange before updating
   * 
   * @param exchange_name - The exchange name (binance/bybit)
   * @param api_key - The API key to verify
   * @param api_secret - The API secret to verify
   * @returns Object with verification results and account info
   */
  async verifyExchangeAccountOwnership(
    exchange_name: string,
    api_key: string,
    api_secret: string,
    passphrase?: string, // Required for some exchanges like Bybit
  ): Promise<{
    valid: boolean;
    accountType?: string;
    permissions?: string[];
    error?: string;
  }> {
    try {
      const normalizedExchange = exchange_name.toLowerCase();
      
      if (normalizedExchange === 'binance') {
        const verification = await this.binanceService.verifyApiKey(api_key, api_secret);
        return {
          valid: verification.valid,
          accountType: verification.accountType,
          permissions: verification.permissions,
        };
      } else if (normalizedExchange === 'bybit') {
        const verification = await this.bybitService.verifyApiKey(api_key, api_secret);
        return {
          valid: verification.valid,
          accountType: verification.accountType,
          permissions: verification.permissions,
        };
      } else {
        return {
          valid: false,
          error: `Unsupported exchange: ${exchange_name}`,
        };
      }
    } catch (error: any) {
      this.logger.error(`Failed to verify exchange account ownership for ${exchange_name}`, error);
      return {
        valid: false,
        error: error?.message || 'Failed to verify exchange credentials',
      };
    }
  }

  /**
   * Updates a user's exchange connection with new API credentials
   * Requires password verification and account ownership validation
   * 
   * @param connectionId - The connection to update
   * @param userId - The user updating the connection (for ownership check)
   * @param api_key - New API key
   * @param api_secret - New API secret
   * @param password - User's password for verification
   * @returns Updated connection object
   */
  async updateConnection(
    connectionId: string,
    userId: string,
    api_key: string,
    api_secret: string,
    password: string,
    passphrase?: string,
  ): Promise<any> {
    // Step 1: Verify connection exists and belongs to user
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    if (connection.user_id !== userId) {
      throw new Error('Unauthorized: This connection does not belong to this user');
    }

    if (!connection.exchange) {
      throw new ConnectionNotFoundException('Exchange not found for this connection');
    }

    // Step 2: Verify user password (ensures user authorization)
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { password_hash: true },
    });

    if (!user || !user.password_hash) {
      throw new Error('User not found or password not set');
    }

    // Import bcrypt for password comparison
    const bcrypt = require('bcryptjs');
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new Error('Invalid password');
    }

    // Step 3: Verify the new credentials with the exchange
    const verification = await this.verifyExchangeAccountOwnership(
      connection.exchange.name,
      api_key,
      api_secret,
      passphrase,
    );

    if (!verification.valid) {
      throw new Error(
        verification.error || 'Failed to verify exchange credentials. Please check your API key and secret.',
      );
    }

    // Step 4: Encrypt the new API credentials
    const apiKeyEncrypted = this.encryptionService.encryptApiKey(api_key);
    const apiSecretEncrypted = this.encryptionService.encryptApiKey(api_secret);

    // Step 5: Update the connection in the database
    const updatedConnection = await this.prisma.user_exchange_connections.update({
      where: { connection_id: connectionId },
      data: {
        api_key_encrypted: apiKeyEncrypted,
        api_secret_encrypted: apiSecretEncrypted,
        status: ConnectionStatus.active,
        connection_metadata: {
          ...(connection.connection_metadata as object || {}),
          accountType: verification.accountType,
          permissions: verification.permissions,
          updated_at: new Date().toISOString(),
          last_verified: new Date().toISOString(),
        },
        last_synced_at: new Date(),
      },
      include: { exchange: true },
    });

    // Step 6: Invalidate cache for this connection
    this.cacheService.invalidate(connectionId);

    // Step 7: Return updated connection (without encrypted keys)
    return {
      connection_id: updatedConnection.connection_id,
      exchange_id: updatedConnection.exchange_id,
      exchange_name: updatedConnection.exchange?.name,
      status: updatedConnection.status,
      created_at: updatedConnection.created_at,
      updated_at: updatedConnection.updated_at,
      account_type: verification.accountType,
      verified: true,
    };
  }

  /**
   * Get symbol-to-CoinGecko ID mapping from database
   * Returns null if not found (will trigger dynamic lookup)
   */
  async getSymbolMapping(symbol: string): Promise<string | null> {
    try {
      // Would use a symbol_mappings table if it exists
      // For now, this is a placeholder for future database schema
      // const mapping = await this.prisma.symbol_mappings.findUnique({
      //   where: { symbol: symbol.toUpperCase() },
      //   select: { coingecko_id: true },
      // });
      // return mapping?.coingecko_id || null;
      
      return null; // No database mapping yet
    } catch (error: any) {
      this.logger.warn(`Failed to query symbol mapping for ${symbol}: ${error?.message}`);
      return null;
    }
  }

  /**
   * Save symbol-to-CoinGecko ID mapping to database
   * Called after successful lookup to avoid repeated API calls
   */
  async saveSymbolMapping(symbol: string, coingeckoId: string): Promise<void> {
    try {
      // Would implement when symbol_mappings table is added
      // await this.prisma.symbol_mappings.upsert({
      //   where: { symbol: symbol.toUpperCase() },
      //   update: { coingecko_id: coingeckoId, updated_at: new Date() },
      //   create: { 
      //     symbol: symbol.toUpperCase(), 
      //     coingecko_id: coingeckoId,
      //     created_at: new Date(),
      //     updated_at: new Date(),
      //   },
      // });
      // this.logger.debug(`Saved symbol mapping: ${symbol} -> ${coingeckoId}`);
    } catch (error: any) {
      this.logger.warn(`Failed to save symbol mapping ${symbol} -> ${coingeckoId}: ${error?.message}`);
    }
  }
}

