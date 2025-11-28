import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeType, ConnectionStatus } from '@prisma/client';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { CacheService } from './services/cache.service';
import { ConnectionNotFoundException } from './exceptions/binance.exceptions';
import {
  AccountBalanceDto,
  OrderDto,
  PositionDto,
  PortfolioDto,
  TickerPriceDto,
} from './dto/binance-data.dto';

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private binanceService: BinanceService,
    private cacheService: CacheService,
  ) {}

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
   * Verifies a connection by testing the API keys with Binance
   */
  async verifyConnection(connectionId: string): Promise<{
    valid: boolean;
    status: ConnectionStatus;
    permissions: string[];
  }> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
    });

    if (!connection) {
      throw new ConnectionNotFoundException();
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }

    try {
      // Decrypt API keys
      const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
      const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

      // Verify with Binance
      const verification = await this.binanceService.verifyApiKey(apiKey, apiSecret);

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
   * Syncs connection data from Binance and caches it
   * Optimized to reduce redundant API calls
   */
  async syncConnectionData(connectionId: string): Promise<void> {
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: connectionId },
    });

    if (!connection || connection.status !== ConnectionStatus.active) {
      throw new ConnectionNotFoundException('Connection not found or not active');
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new ConnectionNotFoundException('Connection missing API credentials');
    }

    // Decrypt API keys
    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    try {
      // OPTIMIZATION: Fetch account info once and reuse it
      // getPositions and getPortfolioValue both need account info, so fetch it once
      const accountInfo = await this.binanceService.getAccountInfo(apiKey, apiSecret);
      
      // Fetch balance, positions, and orders in parallel
      // Portfolio depends on positions, so calculate it after
      const [balance, positions, orders] = await Promise.all([
        // Balance can be derived from account info
        Promise.resolve(this.binanceService.mapAccountToBalance(accountInfo)),
        // Positions uses account info (already fetched)
        this.binanceService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
        // Orders is independent
        this.binanceService.getOpenOrders(apiKey, apiSecret),
      ]);

      // Portfolio is calculated from positions (no additional API call needed)
      const portfolio = this.binanceService.calculatePortfolioFromPositions(positions);

      // Cache the data
      this.cacheService.setCached(`binance:${connectionId}:balance`, balance);
      this.cacheService.setCached(`binance:${connectionId}:positions`, positions);
      this.cacheService.setCached(`binance:${connectionId}:orders`, orders);
      this.cacheService.setCached(`binance:${connectionId}:portfolio`, portfolio);

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
   * Gets connection data (from cache or fresh fetch)
   */
  async getConnectionData(
    connectionId: string,
    dataType: 'balance' | 'positions' | 'orders' | 'portfolio',
  ): Promise<AccountBalanceDto | PositionDto[] | OrderDto[] | PortfolioDto> {
    const cacheKey = `binance:${connectionId}:${dataType}`;
    
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
}

