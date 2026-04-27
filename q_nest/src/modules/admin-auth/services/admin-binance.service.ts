import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BinanceService } from '../../exchanges/integrations/binance.service';
import { BinanceUSService } from '../../exchanges/integrations/binance-us.service';
import { ExchangesService } from '../../exchanges/exchanges.service';

type BinanceVariant = 'binance' | 'binance.us';

interface AdminBinanceContext {
  apiKey: string;
  apiSecret: string;
  variant: BinanceVariant;
  exchangeName: string;
}

@Injectable()
export class AdminBinanceService {
  private readonly logger = new Logger(AdminBinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binanceService: BinanceService,
    private readonly binanceUSService: BinanceUSService,
    private readonly exchangesService: ExchangesService,
  ) {}

  /**
   * Normalize an exchanges.name string to a Binance variant discriminator.
   * Mirrors `ExchangesService.getExchangeService()` matching.
   */
  private normalizeVariant(exchangeName: string): BinanceVariant | null {
    const n = (exchangeName || '').toLowerCase();
    if (n === 'binance') return 'binance';
    if (n === 'binance.us' || n === 'binanceus' || n === 'binance-us') return 'binance.us';
    return null;
  }

  /**
   * Resolve the admin's connected Binance variant + decrypted credentials.
   * Admin connects Binance through POST /exchanges/connections (same as users).
   * `getEffectiveUserId` maps admin → linked user by email.
   */
  private async getAdminBinanceContext(adminId: string): Promise<AdminBinanceContext> {
    const effectiveUserId = await this.exchangesService.getEffectiveUserId(adminId, 'admin');

    const connection = await this.exchangesService.getActiveConnectionByType(effectiveUserId, 'crypto');
    if (!connection) {
      throw new BadRequestException(
        'No active Binance connection found. Please connect Binance in Admin Settings → Exchange Configuration.',
      );
    }

    const variant = this.normalizeVariant(connection.exchange.name);
    if (!variant) {
      throw new BadRequestException(
        `Connected exchange "${connection.exchange.name}" is not Binance or Binance.US. VC pool payments require one of those.`,
      );
    }

    const credentials = await this.exchangesService.getDecryptedCredentials(connection.connection_id);

    return {
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      variant,
      exchangeName: connection.exchange.name,
    };
  }

  /**
   * Public: returns which Binance variant the admin is connected to (for snapshotting / UI).
   * Throws if the admin has no active crypto connection.
   */
  async getAdminExchangeName(adminId: string): Promise<string> {
    const ctx = await this.getAdminBinanceContext(adminId);
    return ctx.exchangeName;
  }

  /**
   * Get admin's deposit history. Routes to BinanceService or BinanceUSService
   * based on which exchange the admin is connected to.
   */
  async getAdminDepositHistory(
    adminId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const ctx = await this.getAdminBinanceContext(adminId);
      const svc = ctx.variant === 'binance.us' ? this.binanceUSService : this.binanceService;

      return svc.getDepositHistory(
        ctx.apiKey,
        ctx.apiSecret,
        coin,
        status,
        offset,
        limit,
        startTime,
        endTime,
      );
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin deposit history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's withdrawal history. Routes by connected variant.
   */
  async getAdminWithdrawalHistory(
    adminId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const ctx = await this.getAdminBinanceContext(adminId);
      const svc = ctx.variant === 'binance.us' ? this.binanceUSService : this.binanceService;

      return svc.getWithdrawalHistory(
        ctx.apiKey,
        ctx.apiSecret,
        coin,
        status,
        offset,
        limit,
        startTime,
        endTime,
      );
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin withdrawal history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's trade history for a symbol (public market data - recent trades).
   * Routes by connected variant so US admins see Binance.US market data.
   */
  async getAdminTradeHistory(
    adminId: string,
    symbol: string,
    limit: number = 50,
  ): Promise<any[]> {
    try {
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: adminId },
        select: { admin_id: true },
      });

      if (!admin) {
        throw new BadRequestException('Admin not found');
      }

      const ctx = await this.getAdminBinanceContext(adminId);
      const svc = ctx.variant === 'binance.us' ? this.binanceUSService : this.binanceService;
      return svc.getRecentTrades(symbol, limit);
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin trade history for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's account info (balance, permissions). Routes by connected variant.
   */
  async getAdminAccountInfo(adminId: string): Promise<any> {
    try {
      const ctx = await this.getAdminBinanceContext(adminId);
      const svc = ctx.variant === 'binance.us' ? this.binanceUSService : this.binanceService;

      return svc.getAccountBalance(ctx.apiKey, ctx.apiSecret);
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin account info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get summary of admin's Binance account
   */
  async getAdminBinanceSummary(
    adminId: string,
    coin?: string,
  ): Promise<{
    account_info: any;
    deposits: any[];
    withdrawals: any[];
    summary: {
      total_deposits: number;
      total_withdrawals: number;
      total_deposit_amount: number;
      total_withdrawal_amount: number;
    };
  }> {
    try {
      const [accountInfo, deposits, withdrawals] = await Promise.all([
        this.getAdminAccountInfo(adminId),
        this.getAdminDepositHistory(adminId, coin, undefined, 0, 100),
        this.getAdminWithdrawalHistory(adminId, coin, undefined, 0, 100),
      ]);

      const totalDepositAmount = deposits.reduce((sum, d) => sum + d.amount, 0);
      const totalWithdrawalAmount = withdrawals.reduce((sum, w) => sum + w.amount, 0);

      return {
        account_info: accountInfo,
        deposits,
        withdrawals,
        summary: {
          total_deposits: deposits.length,
          total_withdrawals: withdrawals.length,
          total_deposit_amount: totalDepositAmount,
          total_withdrawal_amount: totalWithdrawalAmount,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin Binance summary: ${error.message}`);
      throw error;
    }
  }
}
