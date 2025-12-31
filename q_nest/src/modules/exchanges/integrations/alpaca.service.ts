import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class AlpacaService {
  private readonly logger = new Logger(AlpacaService.name);
  private readonly baseUrl = 'https://api.alpaca.markets';
  private readonly apiClient: AxiosInstance;

  constructor() {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  /**
   * Verify Alpaca API key by fetching account
   */
  async verifyApiKey(apiKey: string, apiSecret: string): Promise<{
    valid: boolean;
    permissions: string[];
    accountType: string;
  }> {
    try {
      const res = await this.apiClient.get('/v2/account', {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': apiSecret,
        },
      });

      const data = res.data || {};

      // Alpaca doesn't return explicit permissions like Binance; assume read+trade if account exists
      return {
        valid: true,
        permissions: ['ACCOUNT_READ', 'TRADING'],
        accountType: data.account_blocked ? 'BLOCKED' : 'STOCKS',
      };
    } catch (error: any) {
      this.logger.warn('Alpaca verification failed', error?.response?.data || error?.message || error);
      // Normalize error similar to other services
      throw new Error((error?.response?.data && JSON.stringify(error.response.data)) || error?.message || 'Alpaca verification failed');
    }
  }

  async getAccountInfo(apiKey: string, apiSecret: string): Promise<any> {
    const res = await this.apiClient.get('/v2/account', {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
      },
    });
    return res.data;
  }

  async getPositions(apiKey: string, apiSecret: string): Promise<any[]> {
    const res = await this.apiClient.get('/v2/positions', {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
      },
    });
    return res.data || [];
  }

  async getOrders(apiKey: string, apiSecret: string): Promise<any[]> {
    const res = await this.apiClient.get('/v2/orders', {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
      },
      params: {
        status: 'open',
        limit: 100,
      },
    });
    return res.data || [];
  }
}
