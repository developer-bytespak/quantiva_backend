import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeType, ConnectionStatus } from '@prisma/client';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { BinanceUSService } from './integrations/binance-us.service';
import { BybitService } from './integrations/bybit.service';
import { AlpacaService } from './integrations/alpaca.service';
import { CacheService } from './services/cache.service';
import { BinanceUserWsService } from './services/binance-user-ws.service';
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
type ExchangeService = BinanceService | BinanceUSService | BybitService | AlpacaService;

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  // Deduplication: if a sync is already in progress for a connectionId,
  // subsequent callers wait for the same Promise instead of firing another REST burst.
  private readonly syncInFlight = new Map<string, Promise<void>>();

  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private binanceService: BinanceService,
    private binanceUSService: BinanceUSService,
    private bybitService: BybitService,
    private alpacaService: AlpacaService,
    private cacheService: CacheService,
    private binanceUserWsService: BinanceUserWsService,
  ) {}

  /**
   * Resolve the effective user_id for exchange connections.
   * - If caller is a normal user, return their sub directly.
   * - If caller is an admin, map admin -> user via matching email.
   */
  async getEffectiveUserId(sub: string, role?: string): Promise<string> {
    if (!sub) {
      throw new ForbiddenException('Missing subject in token');
    }

    if (role === 'admin') {
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: sub },
      });
      if (!admin || !admin.email) {
        throw new ForbiddenException('Admin email not found for exchange mapping');
      }

      const user = await this.prisma.users.findUnique({
        where: { email: admin.email },
      });
      if (!user) {
        throw new ForbiddenException('No user account linked to this admin email');
      }

      return user.user_id;
    }

    return sub;
  }

  /**
   * Gets the appropriate exchange service based on exchange name
   */
  private getExchangeService(exchangeName: string): ExchangeService {
    const normalizedName = exchangeName.toLowerCase();
    
    if (normalizedName === 'binance') {
      return this.binanceService;
    } else if (
      normalizedName === 'binance.us' ||
      normalizedName === 'binanceus' ||
      normalizedName === 'binance-us'
    ) {
      return this.binanceUSService;
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

  /**
   * Returns the user's active connection or null. Use when you need to check without throwing (e.g. before creating a new connection).
   */
  async getActiveConnectionOrNull(userId: string): Promise<{
    connection_id: string;
    exchange: { exchange_id: string; name: string; type: string; supports_oauth: boolean; created_at: string | null };
    status: string;
  } | null> {
    const connection = await this.prisma.user_exchange_connections.findFirst({
      where: { user_id: userId, status: ConnectionStatus.active },
      orderBy: { created_at: 'desc' },
    });
    if (!connection) return null;
    const exchange = await this.prisma.exchanges.findUnique({
      where: { exchange_id: connection.exchange_id },
    });
    if (!exchange) return null;
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
  }

  /**
   * Returns the user's active connection for a specific exchange type, or null.
   */
  async getActiveConnectionByType(userId: string, type: 'crypto' | 'stocks'): Promise<{
    connection_id: string;
    exchange: { exchange_id: string; name: string; type: string; supports_oauth: boolean; created_at: string | null };
    status: string;
  } | null> {
    const connection = await this.prisma.user_exchange_connections.findFirst({
      where: {
        user_id: userId,
        status: ConnectionStatus.active,
        exchange: { type: type as ExchangeType },
      },
      include: { exchange: true },
      orderBy: { created_at: 'desc' },
    });
    if (!connection || !connection.exchange) return null;
    return {
      connection_id: connection.connection_id,
      exchange: {
        exchange_id: connection.exchange.exchange_id,
        name: connection.exchange.name,
        type: connection.exchange.type,
        supports_oauth: connection.exchange.supports_oauth,
        created_at: connection.exchange.created_at?.toISOString() || null,
      },
      status: connection.status,
    };
  }

  async getActiveConnection(userId: string) {
    try {
      this.logger.debug(`Fetching active connection for user: ${userId}`);
      const result = await this.getActiveConnectionOrNull(userId);
    if (!result) {
        this.logger.warn(`No active connection found for user: ${userId}`);
      throw new ConnectionNotFoundException('No active connection found');
    }
    return result;
    } catch (error: any) {
      if (error instanceof ConnectionNotFoundException) throw error;
      this.logger.error(`Unexpected error fetching active connection for user ${userId}:`, {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        code: error?.code,
      });
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
    } catch (error: any) {
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
   * Syncs connection data from the exchange and caches it.
   * Deduplicates concurrent calls: if a sync is already in progress for this
   * connection, all callers share the same Promise (no thundering herd).
   */
  async syncConnectionData(connectionId: string): Promise<void> {
    const existing = this.syncInFlight.get(connectionId);
    if (existing) {
      this.logger.debug(`[SYNC] Deduplicating concurrent sync for ${connectionId}`);
      return existing;
    }
    const promise = this._doSyncConnectionData(connectionId).finally(() => {
      this.syncInFlight.delete(connectionId);
    });
    this.syncInFlight.set(connectionId, promise);
    return promise;
  }

  private async _doSyncConnectionData(connectionId: string): Promise<void> {
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
    const isBinanceUS =
      exchangeName === 'binance.us' ||
      exchangeName === 'binanceus' ||
      exchangeName === 'binance-us';
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

        // Keep dashboard resilient: if orders/positions fail, still return balance data.
        balance = this.binanceService.mapAccountToBalance(accountInfo);
        const [positionsResult, ordersResult] = await Promise.allSettled([
          this.binanceService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
          this.binanceService.getOpenOrders(apiKey, apiSecret),
        ]);

        if (positionsResult.status === 'fulfilled') {
          positions = positionsResult.value;
        } else {
          this.logger.warn(
            `Binance positions fetch failed for ${connectionId}, continuing with empty positions: ${positionsResult.reason?.message ?? positionsResult.reason}`,
          );
          positions = [];
        }

        if (ordersResult.status === 'fulfilled') {
          orders = ordersResult.value;
        } else {
          this.logger.warn(
            `Binance open orders fetch failed for ${connectionId}, continuing with empty orders: ${ordersResult.reason?.message ?? ordersResult.reason}`,
          );
          orders = [];
        }

        // Portfolio is calculated from positions
        portfolio = this.binanceService.calculatePortfolioFromPositions(positions);
      } else if (isBinanceUS) {
        // OPTIMIZATION: Fetch account info once and reuse it
        const accountInfo = await this.binanceUSService.getAccountInfo(apiKey, apiSecret);

        // Keep dashboard resilient: if orders/positions fail, still return balance data.
        balance = this.binanceUSService.mapAccountToBalance(accountInfo);
        const [positionsResult, ordersResult] = await Promise.allSettled([
          this.binanceUSService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
          this.binanceUSService.getOpenOrders(apiKey, apiSecret),
        ]);

        if (positionsResult.status === 'fulfilled') {
          positions = positionsResult.value;
        } else {
          this.logger.warn(
            `Binance.US positions fetch failed for ${connectionId}, continuing with empty positions: ${positionsResult.reason?.message ?? positionsResult.reason}`,
          );
          positions = [];
        }

        if (ordersResult.status === 'fulfilled') {
          orders = ordersResult.value;

          // Binance US often has no open orders when market buys are instantly filled.
          // Fallback to recent order history so Action Center can still show activity.
          if (orders.length === 0) {
            try {
              const recentOrders = await this.fetchBinanceUSRecentOrders(
                apiKey,
                apiSecret,
                accountInfo,
              );
              if (recentOrders.length > 0) {
                orders = recentOrders;
                this.logger.debug(
                  `Loaded ${recentOrders.length} recent Binance.US orders for ${connectionId} as fallback`,
                );
              }
            } catch (historyError: any) {
              this.logger.warn(
                `Binance.US recent orders fallback failed for ${connectionId}: ${historyError?.message ?? historyError}`,
              );
            }
          }
        } else {
          this.logger.warn(
            `Binance.US open orders fetch failed for ${connectionId}, continuing with empty orders: ${ordersResult.reason?.message ?? ordersResult.reason}`,
          );
          orders = [];
        }

        // Portfolio is calculated from positions
        portfolio = this.binanceUSService.calculatePortfolioFromPositions(positions);
      } else if (isBybit) {
        // OPTIMIZATION: Fetch account info once and reuse it
        const accountInfo = await this.bybitService.getAccountInfo(apiKey, apiSecret);
        
        // Fetch balance, positions, and orders in parallel
        [balance, positions, orders] = await Promise.all([
          Promise.resolve(this.bybitService.mapAccountToBalance(accountInfo)),
          this.bybitService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
          this.bybitService.getOpenOrders(apiKey, apiSecret),
        ]);

        // Portfolio is calculated from positions, using Bybit's totalEquity for accurate total
        portfolio = this.bybitService.calculatePortfolioFromPositions(positions, accountInfo.totalEquity);
      } else if (isAlpaca) {
        // Fetch account info, positions and orders in parallel.
        const [accountInfo, positionsRaw, ordersRaw] = await Promise.all([
          this.alpacaService.getAccountInfo(apiKey, apiSecret),
          this.alpacaService.getPositions(apiKey, apiSecret),
          this.alpacaService.getOrders(apiKey, apiSecret),
        ]);

        // Map positions. pnlPercent / unrealizedPnl mirror Binance's basic
        // dashboard semantics: the *24h* move on the holding, sourced from
        // Alpaca's intraday fields. Lifetime P&L is recoverable from
        // (currentPrice - entryPrice) * quantity if the caller needs it.
        positions = (positionsRaw || []).map((p: any) => {
          const qty = parseFloat(p.qty || p.quantity || '0') || 0;
          const entryPrice = parseFloat(p.avg_entry_price || p.avg_entry_value || '0') || 0;
          const currentPrice = parseFloat(
            p.current_price || (p.market_value && qty ? (parseFloat(p.market_value) / qty).toString() : '0'),
          ) || 0;
          const intradayPnl = parseFloat(p.unrealized_intraday_pl || '0') || 0;
          const intradayPnlPct = (parseFloat(p.unrealized_intraday_plpc || '0') || 0) * 100;

          return {
            symbol: p.symbol,
            quantity: qty,
            entryPrice,
            currentPrice,
            unrealizedPnl: intradayPnl,
            pnlPercent: intradayPnlPct,
          } as PositionDto;
        });

        // Map balance. The USD asset row uses cash for both free and total so
        // the free <= total invariant holds; buying power is exposed at the
        // top level (balance.buyingPower) for the trading panel.
        const totalValueUSD = parseFloat(accountInfo.equity || accountInfo.portfolio_value || '0') || 0;
        const buyingPower = parseFloat(accountInfo.buying_power || accountInfo.cash || '0') || 0;
        const cash = parseFloat(accountInfo.cash || '0') || 0;
        const assets = (positions || []).map((pos) => ({
          symbol: pos.symbol,
          free: pos.quantity.toString(),
          locked: '0',
          total: pos.quantity.toString(),
        }));
        assets.unshift({
          symbol: 'USD',
          free: cash.toString(),
          locked: '0',
          total: cash.toString(),
        });

        balance = {
          assets,
          totalValueUSD,
          buyingPower,
        } as AccountBalanceDto;

        // Map orders. Alpaca returns lowercase status/type; normalize to the
        // Binance-style uppercase shape so downstream filters work uniformly.
        const ALPACA_ORDER_STATUS_MAP: Record<string, string> = {
          new: 'NEW',
          partially_filled: 'PARTIALLY_FILLED',
          filled: 'FILLED',
          done_for_day: 'FILLED',
          canceled: 'CANCELED',
          expired: 'EXPIRED',
          replaced: 'CANCELED',
          pending_cancel: 'NEW',
          pending_replace: 'NEW',
          accepted: 'NEW',
          pending_new: 'NEW',
          accepted_for_bidding: 'NEW',
          stopped: 'NEW',
          rejected: 'REJECTED',
          suspended: 'NEW',
          calculated: 'NEW',
        };

        orders = (ordersRaw || []).map((o: any) => {
          const rawStatus = (o.status || '').toLowerCase();
          return {
            orderId: o.id || o.client_order_id || '',
            symbol: o.symbol || o.asset_symbol || '',
            side: (o.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
            type: (o.type || o.order_type || '').toUpperCase(),
            quantity: parseFloat(o.qty || o.quantity || '0') || 0,
            price: parseFloat(o.limit_price || o.stop_price || o.filled_avg_price || o.price || '0') || 0,
            status: ALPACA_ORDER_STATUS_MAP[rawStatus] ?? rawStatus.toUpperCase(),
            time: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
          };
        }) as OrderDto[];

        // Portfolio. Use Alpaca's equity directly so portfolio.totalValue
        // matches balance.totalValueUSD and matches what the user sees in
        // their Alpaca account. Cost basis comes from real avg entry prices.
        const totalCost = positions.reduce((acc, p) => acc + (p.entryPrice || 0) * (p.quantity || 0), 0);
        const totalValue = parseFloat(accountInfo.equity || accountInfo.portfolio_value || '0') || 0;
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

      // Start the Binance user data stream after first successful REST sync.
      // Subsequent balance/order requests will be served from the WS cache (zero REST weight).
      // Fire-and-forget — never block the sync response.
      if (isBinance && connection.user_id) {
        this.binanceUserWsService
          .connect(connection.user_id, apiKey, apiSecret)
          .catch((err) =>
            this.logger.warn(`User data stream connect failed for ${connection.user_id}: ${err?.message}`),
          );
      }

      // Update last_synced_at
      await this.prisma.user_exchange_connections.update({
        where: { connection_id: connectionId },
        data: {
          last_synced_at: new Date(),
        },
      });
    } catch (error: any) {
      console.error(`[SYNC] Failed to sync connection data for ${connectionId}:`, error?.message);
      this.logger.error(`Failed to sync connection data for ${connectionId}`, error);

      // Check if it's an authentication error - log but don't mark as invalid for now.
      // The exchange name is already available from earlier in the function, so
      // surface it in the error message instead of hardcoding "Alpaca". This runs
      // for Binance, Binance.US, Bybit, and Alpaca, so a generic/correct message
      // matters — a Binance user shouldn't be told to check their Alpaca keys.
      if (error?.response?.status === 401 || error?.status === 401) {
        const exchangeLabel = connection.exchange?.name || 'exchange';
        console.error(`[SYNC] 401 Unauthorized error - ${exchangeLabel} API credentials may be invalid`);
        // Temporarily disabled: Don't mark as invalid to allow retry
        // await this.prisma.user_exchange_connections.update({
        //   where: { connection_id: connectionId },
        //   data: { status: ConnectionStatus.invalid },
        // }).catch(err => this.logger.error('Failed to update connection status', err));

        throw new Error(
          `API credentials are invalid or expired. Please check your ${exchangeLabel} API keys.`,
        );
      }

      throw error;
    }
  }

  /**
   * Binance US fallback: fetch recent historical orders (FILLED/NEW/etc.)
   * for held assets when open orders are empty.
   */
  private async fetchBinanceUSRecentOrders(
    apiKey: string,
    apiSecret: string,
    accountInfo: any,
  ): Promise<OrderDto[]> {
    const STABLE_ASSETS = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

    const heldAssets = Array.from(
      new Set(
        (accountInfo?.balances || [])
          .filter((b: any) => (parseFloat(b?.free || '0') + parseFloat(b?.locked || '0')) > 0)
          .map((b: any) => String(b?.asset || '').toUpperCase())
          .filter((asset: string) => asset && !STABLE_ASSETS.has(asset)),
      ),
    );

    if (heldAssets.length === 0) {
      return [];
    }

    const candidateSymbols = Array.from(
      new Set(heldAssets.flatMap((asset) => [`${asset}USD`, `${asset}USDT`])),
    );

    const ordersSettled = await Promise.allSettled(
      candidateSymbols.map((symbol) =>
        this.binanceUSService.getAllOrders(apiKey, apiSecret, symbol, { limit: 50 }),
      ),
    );

    const tradesSettled = await Promise.allSettled(
      candidateSymbols.map((symbol) =>
        this.binanceUSService.getMyTrades(apiKey, apiSecret, symbol, { limit: 50 }),
      ),
    );

    const rawOrders: any[] = [];
    for (const result of ordersSettled) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        rawOrders.push(...result.value);
      }
    }

    // Derive FILLED order-like rows from trade history so instantly-filled market orders
    // can still appear in dashboard activity when open orders are empty.
    for (const result of tradesSettled) {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
        continue;
      }

      for (const trade of result.value) {
        rawOrders.push({
          orderId: trade?.orderId,
          symbol: trade?.symbol,
          side: trade?.isBuyer ? 'BUY' : 'SELL',
          type: 'MARKET',
          status: 'FILLED',
          quantity: trade?.qty,
          price: trade?.price,
          time: trade?.time,
          updateTime: trade?.time,
        });
      }
    }

    if (rawOrders.length === 0) {
      return [];
    }

    const unique = new Map<string, any>();
    for (const order of rawOrders) {
      const key = `${order?.orderId || ''}:${order?.symbol || ''}`;
      if (!unique.has(key)) {
        unique.set(key, order);
      }
    }

    return Array.from(unique.values())
      .map((order: any) => ({
        orderId: String(order?.orderId || ''),
        symbol: order?.symbol || '',
        side: (order?.side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        type: order?.type || '',
        quantity: Number(order?.quantity || 0),
        price: Number(order?.price || 0),
        status: order?.status || '',
        time: Number(order?.updateTime || order?.time || Date.now()),
      }))
      .filter((order) => order.orderId && order.symbol)
      .sort((a, b) => b.time - a.time)
      .slice(0, 50);
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

  private static readonly STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

  /**
   * Get all symbols the user has traded (current holdings + open orders).
   * Works for both Binance and Bybit.
   */
  private async getTradedSymbols(connectionId: string): Promise<string[]> {
    const connection = await this.getConnectionById(connectionId);
    if (!connection?.exchange) return [];

    const exchangeName = connection.exchange.name.toLowerCase();
    const { apiKey, apiSecret } = await this.getDecryptedCredentials(connectionId);
    const isBinanceUS = exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us';
    const isBybit = exchangeName === 'bybit';
    const quote = isBinanceUS ? 'USD' : 'USDT';
    const symbolSet = new Set<string>();

    // 1. Current positions
    const positions = await this.getConnectionData(connectionId, 'positions') as PositionDto[];
    if (Array.isArray(positions)) {
      for (const p of positions) {
        if (!ExchangesService.STABLECOINS.has(p.symbol) && p.quantity > 0) {
          symbolSet.add(`${p.symbol}${quote}`);
        }
      }
    }

    // 2. Account balances (includes dust)
    try {
      if (isBybit) {
        const accountInfo = await this.bybitService.getAccountInfo(apiKey, apiSecret);
        for (const c of accountInfo.coin || []) {
          const total = parseFloat(c.walletBalance || '0');
          if (total > 0 && !ExchangesService.STABLECOINS.has(c.coin)) {
            symbolSet.add(`${c.coin}${quote}`);
          }
        }
      } else {
        const service = isBinanceUS ? this.binanceUSService : this.binanceService;
        const accountInfo = await service.getAccountInfo(apiKey, apiSecret);
        for (const b of (accountInfo as any).balances || []) {
          const total = parseFloat(b.free || '0') + parseFloat(b.locked || '0');
          if (total > 0 && !ExchangesService.STABLECOINS.has(b.asset)) {
            symbolSet.add(`${b.asset}${quote}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`getTradedSymbols: accountInfo failed: ${(err as any)?.message}`);
    }

    // 3. Open orders
    try {
      const orders = await this.getConnectionData(connectionId, 'orders') as OrderDto[];
      if (Array.isArray(orders)) {
        for (const o of orders) {
          if (o.symbol && !symbolSet.has(o.symbol)) {
            symbolSet.add(o.symbol);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`getTradedSymbols: orders failed: ${(err as any)?.message}`);
    }

    return Array.from(symbolSet);
  }

  /**
   * Map an Alpaca raw order object to the enriched order shape that
   * /orders/all and /trade-history return for crypto exchanges. Centralized
   * here so both enriched-order methods produce identical Alpaca shapes.
   */
  private mapAlpacaOrderToEnriched(o: any): any {
    const ALPACA_STATUS_MAP: Record<string, string> = {
      new: 'NEW',
      partially_filled: 'PARTIALLY_FILLED',
      filled: 'FILLED',
      done_for_day: 'FILLED',
      canceled: 'CANCELED',
      expired: 'EXPIRED',
      replaced: 'CANCELED',
      pending_cancel: 'NEW',
      pending_replace: 'NEW',
      accepted: 'NEW',
      pending_new: 'NEW',
      accepted_for_bidding: 'NEW',
      stopped: 'NEW',
      rejected: 'REJECTED',
      suspended: 'NEW',
      calculated: 'NEW',
    };

    const rawStatus = (o.status || '').toLowerCase();
    const rawType = (o.type || '').toLowerCase();
    const qty = parseFloat(o.qty || '0') || 0;
    const filledQty = parseFloat(o.filled_qty || '0') || 0;
    const filledAvgPrice = parseFloat(o.filled_avg_price || '0') || 0;
    const limitPrice = parseFloat(o.limit_price || '0') || 0;
    const stopPrice = parseFloat(o.stop_price || '0') || 0;
    const fillPercent = qty > 0 ? Math.round((filledQty / qty) * 100) : 0;
    const totalValue = filledQty * filledAvgPrice;
    const createdMs = o.created_at ? new Date(o.created_at).getTime() : Date.now();
    const updatedMs = o.updated_at ? new Date(o.updated_at).getTime() : createdMs;

    return {
      orderId: o.id || '',
      symbol: o.symbol || '',
      side: (o.side || '').toUpperCase(),
      type: rawType.toUpperCase(),
      status: ALPACA_STATUS_MAP[rawStatus] ?? rawStatus.toUpperCase(),
      fillPercent,
      quantity: qty,
      filledQuantity: filledQty,
      avgFillPrice: Math.round(filledAvgPrice * 100000000) / 100000000,
      orderPrice: rawType === 'market' ? 'Market' : (limitPrice || stopPrice || 0),
      totalValue: Math.round(totalValue * 100000000) / 100000000,
      stopPrice,
      timeInForce: (o.time_in_force || '').toUpperCase(),
      time: createdMs,
      updateTime: updatedMs,
      profitLoss: 0,
      profitLossPercent: 0,
    };
  }

  /**
   * Get all orders (full history) enriched with avgFillPrice, totalValue, fillPercent.
   * Works for both Binance and Bybit.
   */
  async getAllOrdersEnriched(
    connectionId: string,
    params: { symbol?: string; limit?: number },
  ): Promise<any[]> {
    const connection = await this.getConnectionById(connectionId);
    if (!connection?.exchange) return [];

    const exchangeName = connection.exchange.name.toLowerCase();
    const { apiKey, apiSecret } = await this.getDecryptedCredentials(connectionId);

    const isBinance = exchangeName === 'binance';
    const isBinanceUS = exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us';
    const isBybit = exchangeName === 'bybit';
    const isAlpaca = exchangeName === 'alpaca';

    if (!isBinance && !isBinanceUS && !isBybit && !isAlpaca) return [];

    // Alpaca: fetch all orders (open + closed) in one call, map to the
    // enriched shape, apply optional symbol filter, sort newest first.
    // Crypto exchanges fall through to the per-symbol FIFO logic below.
    if (isAlpaca) {
      const limit = Math.min(params.limit || 500, 500);
      const allOrdersRaw = await this.alpacaService.getOrders(
        apiKey,
        apiSecret,
        'all',
        limit,
      );
      let mapped = (allOrdersRaw || []).map((o: any) => this.mapAlpacaOrderToEnriched(o));

      if (params.symbol) {
        const upper = params.symbol.toUpperCase();
        mapped = mapped.filter((o: any) => (o.symbol || '').toUpperCase() === upper);
      }

      return mapped.sort(
        (a: any, b: any) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0),
      );
    }

    // Get symbols to query
    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradedSymbols(connectionId);
    }

    if (symbols.length === 0) return [];

    // Fetch historical orders + currently open/pending orders in parallel
    const [historyResults, openOrders] = await Promise.all([
      // Historical orders per symbol
      Promise.all(
        symbols.map((sym) => {
          let ordersPromise: Promise<any[]>;
          if (isBybit) {
            ordersPromise = this.bybitService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 50 });
          } else if (isBinanceUS) {
            ordersPromise = this.binanceUSService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          } else {
            ordersPromise = this.binanceService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          }
          return ordersPromise.catch((err) => {
            this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
            return [];
          });
        }),
      ),
      // Currently open orders (includes untriggered stop orders for Bybit)
      (async () => {
        try {
          if (isBybit) {
            return await this.bybitService.getOpenOrders(apiKey, apiSecret);
          } else if (isBinanceUS) {
            return await this.binanceUSService.getOpenOrders(apiKey, apiSecret);
          } else {
            return await this.binanceService.getOpenOrders(apiKey, apiSecret);
          }
        } catch {
          return [];
        }
      })(),
    ]);

    const historicalOrders = historyResults.flat();

    // Merge: convert open orders to same format, deduplicate by orderId
    const historicalOrderIds = new Set(historicalOrders.map((o) => String(o.orderId)));
    const pendingOrders = (openOrders as any[])
      .filter((o) => !historicalOrderIds.has(String(o.orderId)))
      .map((o) => {
        const type = o.type || '';
        const isStopMarket = type === 'STOP_MARKET';
        const isStopLimit = type === 'STOP_LIMIT';
        const triggerPrice = Number(o.triggerPrice) || 0;

        return {
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          status: o.status === 'NEW' || o.status === 'Untriggered' ? 'NEW' : o.status,
          quantity: Number(o.quantity) || 0,
          executedQty: 0,
          // For stop orders, use triggerPrice as the price (like Binance puts price in orderPrice for SL/TP)
          price: (isStopMarket || isStopLimit) ? (triggerPrice || Number(o.price) || 0) : (Number(o.price) || 0),
          cummulativeQuoteQty: 0,
          // SL (STOP_MARKET): stopPrice = trigger price, like Binance STOP_LOSS_LIMIT
          // TP (STOP_LIMIT): stopPrice = 0, like Binance LIMIT_MAKER
          stopPrice: isStopMarket ? triggerPrice : 0,
          timeInForce: isStopLimit ? 'GTC' : '',
          time: o.time,
          updateTime: o.time,
        };
      });

    const allOrders = [...historicalOrders, ...pendingOrders];

    // Enrich each order with calculated fields
    return allOrders
      .map((order) => {
        const qty = Number(order.quantity) || 0;
        const execQty = Number(order.executedQty) || 0;
        const quoteQty = Number(order.cummulativeQuoteQty) || 0;
        const avgFillPrice = execQty > 0 ? quoteQty / execQty : 0;
        const fillPercent = qty > 0 ? Math.round((execQty / qty) * 100) : 0;

        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          fillPercent,
          quantity: qty,
          filledQuantity: execQty,
          avgFillPrice: Math.round(avgFillPrice * 100000000) / 100000000,
          orderPrice: order.type === 'MARKET' ? (order.stopPrice || 'Market') : (order.price || order.stopPrice || 0),
          totalValue: Math.round(quoteQty * 100000000) / 100000000,
          stopPrice: order.type === 'STOP_MARKET' || order.type === 'STOP_LOSS_LIMIT' ? (order.stopPrice || order.price || 0) : (order.stopPrice || 0),
          timeInForce: order.timeInForce,
          time: order.time,
          updateTime: order.updateTime,
        };
      })
      .sort((a, b) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0));
  }

  /**
   * Get trade history with FIFO-matched realized P&L.
   * Works for both Binance and Bybit.
   */
  async getTradeHistoryEnriched(
    connectionId: string,
    params: { symbol?: string; limit?: number },
  ): Promise<any[]> {
    const connection = await this.getConnectionById(connectionId);
    if (!connection?.exchange) return [];

    const exchangeName = connection.exchange.name.toLowerCase();
    const { apiKey, apiSecret } = await this.getDecryptedCredentials(connectionId);

    const isBinance = exchangeName === 'binance';
    const isBinanceUS = exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us';
    const isBybit = exchangeName === 'bybit';
    const isAlpaca = exchangeName === 'alpaca';

    if (!isBinance && !isBinanceUS && !isBybit && !isAlpaca) return [];

    // Alpaca: pull all orders, keep only those with executed quantity, then
    // run FIFO matching per symbol to compute realized P&L on SELL orders.
    // Same FIFO logic as the crypto branch below — just sourced from Alpaca's
    // single /v2/orders endpoint instead of per-symbol myTrades calls.
    if (isAlpaca) {
      const limit = Math.min(params.limit || 500, 500);
      const allOrdersRaw = await this.alpacaService.getOrders(
        apiKey,
        apiSecret,
        'all',
        limit,
      );

      let mapped = (allOrdersRaw || [])
        .map((o: any) => this.mapAlpacaOrderToEnriched(o))
        .filter((o: any) => o.filledQuantity > 0);

      if (params.symbol) {
        const upper = params.symbol.toUpperCase();
        mapped = mapped.filter((o: any) => (o.symbol || '').toUpperCase() === upper);
      }

      // FIFO matching per symbol: attach realized P&L to SELL orders
      const ordersBySymbol: Record<string, any[]> = {};
      for (const o of mapped) {
        if (!ordersBySymbol[o.symbol]) ordersBySymbol[o.symbol] = [];
        ordersBySymbol[o.symbol].push(o);
      }

      for (const [, orders] of Object.entries(ordersBySymbol)) {
        const sorted = [...orders].sort((a: any, b: any) => a.time - b.time);
        const buyQueue: { avgPrice: number; remainingQty: number }[] = [];

        for (const order of sorted) {
          if (order.side === 'BUY') {
            buyQueue.push({ avgPrice: order.avgFillPrice, remainingQty: order.filledQuantity });
          } else if (order.side === 'SELL') {
            let remainingQty = order.filledQuantity;
            let totalPL = 0;
            let totalEntryCost = 0;

            while (remainingQty > 0 && buyQueue.length > 0) {
              const oldest = buyQueue[0];
              const matchedQty = Math.min(remainingQty, oldest.remainingQty);
              totalPL += (order.avgFillPrice - oldest.avgPrice) * matchedQty;
              totalEntryCost += oldest.avgPrice * matchedQty;

              remainingQty -= matchedQty;
              oldest.remainingQty -= matchedQty;
              if (oldest.remainingQty <= 0) buyQueue.shift();
            }

            order.profitLoss = Math.round(totalPL * 1000) / 1000;
            order.profitLossPercent = totalEntryCost > 0
              ? Math.round(((totalPL / totalEntryCost) * 100) * 100) / 100
              : 0;
          }
        }
      }

      return mapped.sort((a: any, b: any) => b.time - a.time);
    }

    // Get symbols to query
    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradedSymbols(connectionId);
    }

    if (symbols.length === 0) return [];

    // Fetch all orders and trade fills in parallel for each symbol
    const [allOrdersPerSymbol, allTradesPerSymbol] = await Promise.all([
      Promise.all(
        symbols.map((sym) => {
          let promise: Promise<any[]>;
          if (isBybit) {
            promise = this.bybitService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 50 });
          } else if (isBinanceUS) {
            promise = this.binanceUSService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          } else {
            promise = this.binanceService.getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          }
          return promise.catch((err) => {
            this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
            return [];
          });
        }),
      ),
      Promise.all(
        symbols.map((sym) => {
          let promise: Promise<any[]>;
          if (isBybit) {
            promise = this.bybitService.getMyTrades(apiKey, apiSecret, sym, { limit: 100 });
          } else if (isBinanceUS) {
            promise = this.binanceUSService.getMyTrades(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          } else {
            promise = this.binanceService.getMyTrades(apiKey, apiSecret, sym, { limit: params.limit || 500 });
          }
          return promise.catch((err) => {
            this.logger.warn(`getMyTrades failed for ${sym}: ${err.message}`);
            return [];
          });
        }),
      ),
    ]);

    const allOrders = allOrdersPerSymbol.flat();
    const allFills = allTradesPerSymbol.flat();

    // Group fills by orderId for enrichment
    const fillsByOrderId: Record<string, any[]> = {};
    for (const fill of allFills) {
      const oid = String(fill.orderId);
      if (!fillsByOrderId[oid]) fillsByOrderId[oid] = [];
      fillsByOrderId[oid].push(fill);
    }

    // Include all orders that have been executed (any amount filled)
    const enrichedOrders = allOrders
      .filter((o) => o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED' || (Number(o.executedQty) || 0) > 0)
      .map((order) => {
        const fills = fillsByOrderId[String(order.orderId)] || [];
        const totalFilledQty = fills.reduce((s: number, f: any) => s + (Number(f.qty) || 0), 0);
        const totalQuoteQty = fills.reduce((s: number, f: any) => s + (Number(f.quoteQty) || 0), 0);
        const totalFee = fills.reduce((s: number, f: any) => s + (Number(f.commission) || 0), 0);
        const execQty = Number(order.executedQty) || 0;
        const avgPrice = totalFilledQty > 0 ? totalQuoteQty / totalFilledQty
          : (execQty > 0 && Number(order.cummulativeQuoteQty) > 0 ? Number(order.cummulativeQuoteQty) / execQty : Number(order.price) || 0);
        const feeAsset = fills.length > 0 ? fills[0].commissionAsset : '';
        const fillPercent = (Number(order.quantity) || 0) > 0
          ? Math.round((execQty / Number(order.quantity)) * 100)
          : 0;

        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          fillPercent,
          quantity: Number(order.quantity) || 0,
          filledQuantity: execQty,
          avgPrice: Math.round(avgPrice * 100000000) / 100000000,
          orderPrice: order.type === 'MARKET' ? (order.stopPrice || 'Market') : (order.price || order.stopPrice || 0),
          totalValue: Math.round((totalQuoteQty || Number(order.cummulativeQuoteQty) || 0) * 100000000) / 100000000,
          totalFee: Math.round(totalFee * 100000000) / 100000000,
          feeAsset,
          stopPrice: order.stopPrice,
          time: order.time,
          updateTime: order.updateTime,
          profitLoss: 0,
          profitLossPercent: 0,
        };
      });

    // FIFO matching: attach P&L to SELL orders
    const ordersBySymbol: Record<string, any[]> = {};
    for (const o of enrichedOrders) {
      if (!ordersBySymbol[o.symbol]) ordersBySymbol[o.symbol] = [];
      ordersBySymbol[o.symbol].push(o);
    }

    for (const [, orders] of Object.entries(ordersBySymbol)) {
      const sorted = [...orders].sort((a, b) => a.time - b.time);
      const buyQueue: { avgPrice: number; remainingQty: number }[] = [];

      for (const order of sorted) {
        if (order.side === 'BUY') {
          buyQueue.push({ avgPrice: order.avgPrice, remainingQty: order.filledQuantity });
        } else if (order.side === 'SELL') {
          let remainingQty = order.filledQuantity;
          let totalPL = 0;
          let totalEntryCost = 0;

          while (remainingQty > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matchedQty = Math.min(remainingQty, oldest.remainingQty);
            totalPL += (order.avgPrice - oldest.avgPrice) * matchedQty;
            totalEntryCost += oldest.avgPrice * matchedQty;

            remainingQty -= matchedQty;
            oldest.remainingQty -= matchedQty;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }

          order.profitLoss = Math.round(totalPL * 1000) / 1000;
          order.profitLossPercent = totalEntryCost > 0
            ? Math.round(((totalPL / totalEntryCost) * 100) * 100) / 100
            : 0;
        }
      }
    }

    return enrichedOrders.sort((a, b) => b.time - a.time);
  }

  /**
   * Enriches basic positions with real FIFO entry prices and P&L.
   * Works for both Binance and Bybit by fetching trade history and computing avg entry.
   */
  async enrichPositionsWithFIFO(
    connectionId: string,
    positions: PositionDto[],
  ): Promise<any[]> {
    if (!Array.isArray(positions) || positions.length === 0) return positions || [];

    const connection = await this.getConnectionById(connectionId);
    if (!connection?.exchange) return positions;

    const exchangeName = connection.exchange.name.toLowerCase();
    const { apiKey, apiSecret } = await this.getDecryptedCredentials(connectionId);

    const isBinance = exchangeName === 'binance';
    const isBinanceUS = exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us';
    const isBybit = exchangeName === 'bybit';
    const isAlpaca = exchangeName === 'alpaca';

    if (!isBinance && !isBinanceUS && !isBybit && !isAlpaca) return positions;

    // Alpaca already provides the real avg entry price on each position from
    // /v2/positions, so no FIFO trade-fill fetch is needed. Map directly to
    // the enriched shape using the same field set as the crypto path below.
    // Lifetime P&L = marketValue - totalCost; intraday P&L is carried on the
    // basic position as unrealizedPnl/pnlPercent (from the dashboard mapper).
    if (isAlpaca) {
      return positions.map((p) => {
        const qty = Number(p.quantity) || 0;
        const curPrice = Number(p.currentPrice) || 0;
        const avgEntryPrice = Number(p.entryPrice) || 0;
        const hasRealEntry = avgEntryPrice > 0;
        const totalCost = avgEntryPrice * qty;
        const marketValue = curPrice * qty;
        const totalPnl = hasRealEntry ? marketValue - totalCost : 0;
        const totalPnlPercent = hasRealEntry && totalCost > 0
          ? ((marketValue - totalCost) / totalCost) * 100
          : 0;

        return {
          symbol: p.symbol,
          quantity: qty,
          avgEntryPrice: Math.round(avgEntryPrice * 100000000) / 100000000,
          currentPrice: curPrice,
          marketValue: Math.round(marketValue * 100000000) / 100000000,
          totalCost: Math.round(totalCost * 100000000) / 100000000,
          unrealizedPnl: Math.round(totalPnl * 1000) / 1000,
          unrealizedPnlPercent: Math.round(totalPnlPercent * 100) / 100,
          dailyChangePnl: Math.round((Number(p.unrealizedPnl) || 0) * 1000) / 1000,
          dailyChangePercent: Math.round((Number(p.pnlPercent) || 0) * 100) / 100,
          hasRealEntry,
        };
      });
    }

    const quote = isBinanceUS ? 'USD' : 'USDT';

    // Filter non-stablecoin positions with quantity > 0
    const nonStablePositions = positions.filter(
      (p) => !ExchangesService.STABLECOINS.has(p.symbol) && p.quantity > 0,
    );

    // Fetch trade fills for each position
    const fillsPerSymbol = await Promise.all(
      nonStablePositions.map((p) => {
        const symbol = `${p.symbol}${quote}`;
        let tradesPromise: Promise<any[]>;

        if (isBybit) {
          tradesPromise = this.bybitService.getMyTrades(apiKey, apiSecret, symbol, { limit: 100 });
        } else if (isBinanceUS) {
          tradesPromise = this.binanceUSService.getMyTrades(apiKey, apiSecret, symbol, { limit: 1000 });
        } else {
          tradesPromise = this.binanceService.getMyTrades(apiKey, apiSecret, symbol, { limit: 1000 });
        }

        return tradesPromise
          .then((fills) => ({ symbol: p.symbol, fills }))
          .catch(() => ({ symbol: p.symbol, fills: [] as any[] }));
      }),
    );

    // FIFO matching per symbol to get avg entry price
    const entryPriceMap = new Map<string, number>();

    for (const { symbol, fills } of fillsPerSymbol) {
      if (fills.length === 0) continue;

      const sorted = [...fills].sort((a, b) => a.time - b.time);
      const buyQueue: { price: number; remainingQty: number }[] = [];

      for (const fill of sorted) {
        if (fill.isBuyer) {
          const fPrice = Number(fill.price) || 0;
          const fQty = Number(fill.qty) || 0;
          if (fPrice > 0 && fQty > 0) {
            buyQueue.push({ price: fPrice, remainingQty: fQty });
          }
        } else {
          let remaining = Number(fill.qty) || 0;
          while (remaining > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matched = Math.min(remaining, oldest.remainingQty);
            remaining -= matched;
            oldest.remainingQty -= matched;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }
        }
      }

      if (buyQueue.length > 0) {
        const totalCost = buyQueue.reduce((s, b) => s + b.price * b.remainingQty, 0);
        const totalQty = buyQueue.reduce((s, b) => s + b.remainingQty, 0);
        if (totalQty > 0) {
          entryPriceMap.set(symbol, totalCost / totalQty);
        }
      }
    }

    // Enrich positions with real entry price and P&L
    return positions.map((p) => {
      const qty = Number(p.quantity) || 0;
      const curPrice = Number(p.currentPrice) || 0;
      const realEntryPrice = entryPriceMap.get(p.symbol);
      const hasRealEntry = realEntryPrice !== undefined && realEntryPrice > 0;
      const avgEntryPrice = hasRealEntry ? realEntryPrice : (Number(p.entryPrice) || curPrice);
      const totalCost = avgEntryPrice * qty;
      const marketValue = curPrice * qty;
      const totalPnl = hasRealEntry ? marketValue - totalCost : 0;
      const totalPnlPercent = hasRealEntry && totalCost > 0
        ? ((marketValue - totalCost) / totalCost) * 100
        : 0;

      return {
        symbol: p.symbol,
        quantity: qty,
        avgEntryPrice: Math.round(avgEntryPrice * 100000000) / 100000000,
        currentPrice: curPrice,
        marketValue: Math.round(marketValue * 100000000) / 100000000,
        totalCost: Math.round(totalCost * 100000000) / 100000000,
        unrealizedPnl: Math.round(totalPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(totalPnlPercent * 100) / 100,
        dailyChangePnl: Math.round((Number(p.unrealizedPnl) || 0) * 1000) / 1000,
        dailyChangePercent: Math.round((Number(p.pnlPercent) || 0) * 100) / 100,
        hasRealEntry,
      };
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

    // Try User Data Stream cache for Binance balance (zero REST weight)
    if (dataType === 'balance' && exchangeName === 'binance' && connection.user_id) {
      const wsBalance = this.binanceUserWsService.getLastBalance(connection.user_id);
      if (wsBalance && Object.keys(wsBalance).length > 0) {
        this.logger.debug(`Serving balance from WS cache for connection ${connectionId}`);
        this.cacheService.setCached(cacheKey, wsBalance);
        return wsBalance as any;
      }
    }

    // Try User Data Stream cache for Binance orders (zero REST weight)
    if (dataType === 'orders' && exchangeName === 'binance' && connection.user_id) {
      const wsOrders = this.binanceUserWsService.getLastOrders(connection.user_id);
      if (wsOrders.length > 0) {
        this.logger.debug(`Serving orders from WS cache for connection ${connectionId}`);
        this.cacheService.setCached(cacheKey, wsOrders);
        return wsOrders as any;
      }
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

          // Kick off user data stream so future balance/order requests are served from WS cache
          if (exchangeName === 'binance' && connection.user_id) {
            this.binanceUserWsService
              .connect(connection.user_id, apiKey, apiSecret)
              .catch((err) =>
                this.logger.warn(`User data stream connect failed for ${connection.user_id}: ${err?.message}`),
              );
          }

          return balance;
        }
      } catch (error: any) {
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

    let placedOrder: OrderDto;

    if (exchangeService instanceof BinanceService) {
      placedOrder = await this.binanceService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else if (exchangeService instanceof BinanceUSService) {
      const normalizedSymbol = symbol.toUpperCase().endsWith('USDT')
        ? symbol.toUpperCase().replace(/USDT$/, 'USD')
        : symbol;
      placedOrder = await this.binanceUSService.placeOrder(apiKey, apiSecret, normalizedSymbol, side, type, quantity, price);
    } else if (exchangeService instanceof BybitService) {
      placedOrder = await this.bybitService.placeOrder(apiKey, apiSecret, symbol, side, type, quantity, price);
    } else if (exchangeService instanceof AlpacaService) {
      // Product decision: Alpaca crypto is not offered to end users on the
      // unified user-initiated flow. Block here before dispatching so the
      // guard applies to this entry point only — the strategies paper-trading
      // flow calls AlpacaService.placeOrder directly and is untouched.
      if (this.alpacaService.isAlpacaCryptoSymbol(symbol)) {
        throw new HttpException(
          {
            success: false,
            code: 'ALPACA_CRYPTO_NOT_SUPPORTED',
            message:
              'Crypto trading is not supported on your Alpaca connection. Use a Binance, Binance.US, or Bybit connection for crypto orders.',
            symbol,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      placedOrder = await this.alpacaService.placeOrder(
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

    // Ensure subsequent dashboard/orders requests are not served stale cache.
    this.cacheService.invalidate(connectionId);

    // Refresh snapshots in background (non-blocking for order placement latency).
    this.syncConnectionData(connectionId).catch((err) =>
      this.logger.warn(`Post-order sync failed for ${connectionId}: ${err?.message || err}`),
    );

    return placedOrder;
  }

  async placeOcoOrder(
    connectionId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<{ orderListId: number; takeProfitPrice: number; stopLossPrice: number }> {
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

    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    const exchangeService = this.getExchangeService(connection.exchange.name);

    let result: { orderListId: number };
    if (exchangeService instanceof BinanceService) {
      result = await this.binanceService.placeOcoOrder(
        apiKey,
        apiSecret,
        symbol,
        side,
        quantity,
        takeProfitPrice,
        stopLossPrice,
      );
    } else if (exchangeService instanceof BinanceUSService) {
      const normalizedSymbol = symbol.toUpperCase().endsWith('USDT')
        ? symbol.toUpperCase().replace(/USDT$/, 'USD')
        : symbol;
      result = await this.binanceUSService.placeOcoOrder(
        apiKey,
        apiSecret,
        normalizedSymbol,
        side,
        quantity,
        takeProfitPrice,
        stopLossPrice,
      );
    } else {
      throw new Error(`OCO orders are only supported on Binance/Binance US, not ${connection.exchange.name}`);
    }

    // Ensure subsequent dashboard/orders requests are not served stale cache.
    this.cacheService.invalidate(connectionId);

    // Refresh snapshots in background (non-blocking for OCO placement latency).
    this.syncConnectionData(connectionId).catch((err) =>
      this.logger.warn(`Post-OCO sync failed for ${connectionId}: ${err?.message || err}`),
    );

    return {
      orderListId: result.orderListId,
      takeProfitPrice,
      stopLossPrice,
    };
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
      // Alpaca's retail Data API only exposes a 1-level quote (best bid/ask),
      // which doesn't fit the multi-level depth shape this endpoint returns.
      // Same 501 pattern as deposits/withdrawals — frontend can hide the
      // order book widget on an "not supported" response instead of showing
      // a 500 error toast.
      throw new HttpException(
        {
          success: false,
          code: 'FEATURE_NOT_SUPPORTED',
          feature: 'orderbook',
          exchange: connection.exchange.name,
          message: `Order book is not available for ${connection.exchange.name} connections.`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
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
    } else if (exchangeName === 'alpaca') {
      // Alpaca Data API requires credentials even for recent trades.
      // The AlpacaService wrapper maps the response directly to RecentTradeDto
      // so this endpoint stays uniform across all exchanges.
      const { apiKey, apiSecret } = await this.getDecryptedCredentials(connectionId);
      return this.alpacaService.getRecentTrades(apiKey, apiSecret, symbol, limit);
    } else {
      throw new HttpException(
        {
          success: false,
          code: 'FEATURE_NOT_SUPPORTED',
          feature: 'trades',
          exchange: connection.exchange.name,
          message: `Recent trades are not available for ${connection.exchange.name} connections.`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
  }

  /**
   * Gets deposit history for a connection
   */
  async getDepositHistory(
    connectionId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();

    if (exchangeName === 'binance') {
      // Decrypt the API credentials
      const credentials = await this.getDecryptedCredentials(connectionId);
      return this.binanceService.getDepositHistory(
        credentials.apiKey,
        credentials.apiSecret,
        coin,
        status,
        offset,
        limit,
        startTime,
        endTime,
      );
    } else {
      // Not a fatal error — just a feature gap. Return a structured 501 so
      // the frontend can render a friendly "not available on this exchange"
      // message instead of an opaque 500. Applies to Alpaca, Bybit, and
      // Binance.US; only Binance currently exposes deposit history.
      throw new HttpException(
        {
          success: false,
          code: 'FEATURE_NOT_SUPPORTED',
          feature: 'deposits',
          exchange: connection.exchange.name,
          message: `Deposit history is not available for ${connection.exchange.name} connections.`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
  }

  /**
   * Gets withdrawal history for a connection
   */
  async getWithdrawalHistory(
    connectionId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
      include: { exchange: true },
    });

    if (!connection || !connection.exchange) {
      throw new ConnectionNotFoundException('Connection not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();

    if (exchangeName === 'binance') {
      // Decrypt the API credentials
      const credentials = await this.getDecryptedCredentials(connectionId);
      return this.binanceService.getWithdrawalHistory(
        credentials.apiKey,
        credentials.apiSecret,
        coin,
        status,
        offset,
        limit,
        startTime,
        endTime,
      );
    } else {
      // Same rationale as getDepositHistory: return a structured 501 so the
      // frontend can show a friendly "not available" message rather than an
      // opaque 500. Only Binance currently exposes withdrawal history.
      throw new HttpException(
        {
          success: false,
          code: 'FEATURE_NOT_SUPPORTED',
          feature: 'withdrawals',
          exchange: connection.exchange.name,
          message: `Withdrawal history is not available for ${connection.exchange.name} connections.`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
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
    password?: string,
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

    // Step 2: Verify user password if the user has one (skip for OAuth-only accounts)
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { password_hash: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (user.password_hash && password) {
      const bcrypt = require('bcryptjs');
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        throw new Error('Invalid password');
      }
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

