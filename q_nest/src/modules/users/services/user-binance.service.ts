import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BinanceService } from '../../exchanges/integrations/binance.service';
import { EncryptionService } from '../../exchanges/services/encryption.service';

@Injectable()
export class UserBinanceService {
  private readonly logger = new Logger(UserBinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binanceService: BinanceService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Get user's decrypted Binance API credentials from exchange connections
   */
  private async getUserBinanceCredentials(
    userId: string,
  ): Promise<{ apiKey: string; apiSecret: string }> {
    const connection = await this.prisma.user_exchange_connections.findFirst({
      where: {
        user_id: userId,
        status: 'active',
        exchange: { name: { contains: 'binance', mode: 'insensitive' } },
      },
      include: { exchange: true },
    });

    if (!connection) {
      throw new BadRequestException(
        'No active Binance connection found. Please connect your Binance account first.',
      );
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      throw new BadRequestException(
        'Binance API credentials not configured. Please update your Binance connection with valid API keys.',
      );
    }

    try {
      return {
        apiKey: this.encryptionService.decryptApiKey(connection.api_key_encrypted),
        apiSecret: this.encryptionService.decryptApiKey(connection.api_secret_encrypted),
      };
    } catch (error: any) {
      this.logger.error(`Failed to decrypt user Binance credentials: ${error.message}`);
      throw new BadRequestException(`Failed to decrypt Binance credentials: ${error.message}`);
    }
  }

  /**
   * Get user's deposit history
   */
  async getDepositHistory(
    userId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const credentials = await this.getUserBinanceCredentials(userId);

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
      this.logger.error(`Failed to fetch user deposit history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user's withdrawal history
   */
  async getWithdrawalHistory(
    userId: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const credentials = await this.getUserBinanceCredentials(userId);

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
      this.logger.error(`Failed to fetch user withdrawal history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user's account info (balance, permissions)
   */
  async getAccountInfo(userId: string): Promise<any> {
    try {
      const credentials = await this.getUserBinanceCredentials(userId);

      return this.binanceService.getAccountBalance(
        credentials.apiKey,
        credentials.apiSecret,
      );
    } catch (error: any) {
      this.logger.error(`Failed to fetch user account info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get summary of user's Binance account
   * Returns deposits, withdrawals, account info, and aggregated stats
   */
  async getBinanceSummary(
    userId: string,
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
        this.getAccountInfo(userId),
        this.getDepositHistory(userId, coin, undefined, 0, 100),
        this.getWithdrawalHistory(userId, coin, undefined, 0, 100),
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
      this.logger.error(`Failed to fetch user Binance summary: ${error.message}`);
      throw error;
    }
  }
}
