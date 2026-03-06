import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BinanceService } from '../../exchanges/integrations/binance.service';
import { EncryptionUtil } from '../../../common/utils/encryption.util';

@Injectable()
export class AdminBinanceService {
  private readonly logger = new Logger(AdminBinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binanceService: BinanceService,
  ) {}

  /**
   * Get admin's decrypted Binance API credentials
   */
  private async getAdminBinanceCredentials(
    adminId: string,
  ): Promise<{ apiKey: string; apiSecret: string }> {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: {
        binance_api_key_encrypted: true,
        binance_api_secret_encrypted: true,
      },
    });

    if (!admin) {
      throw new BadRequestException('Admin not found');
    }

    if (!admin.binance_api_key_encrypted || !admin.binance_api_secret_encrypted) {
      throw new BadRequestException(
        'Binance API credentials not configured for this admin account. Please configure Binance API keys in admin settings.',
      );
    }

    try {
      const encryptionKey = process.env.ENCRYPTION_KEY;
      if (!encryptionKey) {
        this.logger.error('ENCRYPTION_KEY not found in environment variables');
        throw new BadRequestException('Encryption key not configured on server');
      }

      return {
        apiKey: EncryptionUtil.decrypt(admin.binance_api_key_encrypted, encryptionKey),
        apiSecret: EncryptionUtil.decrypt(admin.binance_api_secret_encrypted, encryptionKey),
      };
    } catch (error: any) {
      this.logger.error(`Failed to decrypt admin Binance credentials: ${error.message}`);
      throw new BadRequestException(`Failed to decrypt Binance credentials: ${error.message}`);
    }
  }

  /**
   * Get admin's deposit history
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
      const credentials = await this.getAdminBinanceCredentials(adminId);

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
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin deposit history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's withdrawal history
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
      const credentials = await this.getAdminBinanceCredentials(adminId);

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
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin withdrawal history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's trade history for a symbol (public market data - recent trades)
   * Note: This fetches public trades, not admin's personal trade history
   * For admin's own trades, use getAdminAccountInfo which shows order history
   */
  async getAdminTradeHistory(
    adminId: string,
    symbol: string,
    limit: number = 50,
  ): Promise<any[]> {
    try {
      // Validate admin exists
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: adminId },
        select: { admin_id: true },
      });

      if (!admin) {
        throw new BadRequestException('Admin not found');
      }

      return this.binanceService.getRecentTrades(symbol, limit);
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin trade history for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin's account info (balance, permissions)
   */
  async getAdminAccountInfo(adminId: string): Promise<any> {
    try {
      const credentials = await this.getAdminBinanceCredentials(adminId);

      // You can reuse getAccountBalance from BinanceService if it exists
      // Or use getAccountInfo from exchanges service
      const accountInfo = await this.binanceService.getAccountBalance(
        credentials.apiKey,
        credentials.apiSecret,
      );

      return accountInfo;
    } catch (error: any) {
      this.logger.error(`Failed to fetch admin account info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get summary of admin's Binance account
   * Returns deposits, withdrawals, and account info
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
