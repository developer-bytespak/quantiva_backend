import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';

@Injectable()
export class PythonApiService {
  private readonly logger = new Logger(PythonApiService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('PYTHON_API_URL', 'http://localhost:8000');
    this.logger.log(`🔧 PythonApiService initialized with baseUrl: ${this.baseUrl}`);
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000, // 5 minutes - increased for face matching (embedding + comparison is CPU-intensive)
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Strategy and Signal Generation Methods

  async validateStrategy(strategyRules: any): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const response = await this.axiosInstance.post<{ valid: boolean; errors: string[] }>(
        '/api/v1/strategies/validate',
        strategyRules,
      );
      return response.data;
    } catch (error: any) {
      this.logger.error('Strategy validation request failed', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
      });
      throw error;
    }
  }

  async parseStrategy(strategyRules: any): Promise<any> {
    try {
      const response = await this.axiosInstance.post('/api/v1/strategies/parse', strategyRules);
      return response.data;
    } catch (error: any) {
      this.logger.error('Strategy parsing request failed', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
      });
      throw error;
    }
  }

  async generateSignal(
    strategyId: string,
    assetId: string,
    requestData: {
      strategy_data: any;
      market_data: any;
      ohlcv_data?: any;
      order_book?: any;
      portfolio_value?: number;
      connection_id?: string | null;
      exchange?: string;
      asset_symbol?: string;
    },
  ): Promise<any> {
    try {
      const response = await this.axiosInstance.post('/api/v1/signals/generate', {
        strategy_id: strategyId,
        asset_id: assetId,
        asset_type: requestData.market_data?.asset_type || 'crypto',
        connection_id: requestData.connection_id || null,
        exchange: requestData.exchange || 'binance',
        asset_symbol: requestData.asset_symbol || assetId, // Use symbol if provided, fallback to assetId
        ...requestData,
      });
      return response.data;
    } catch (error: any) {
      this.logger.error('Signal generation request failed', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
      });
      throw error;
    }
  }

  // Public helper methods to allow other services to make HTTP calls
  public async post<T = any>(path: string, data?: any, config?: any) {
    return this.axiosInstance.post<T>(path, data, config);
  }

  public async get<T = any>(path: string, config?: any) {
    return this.axiosInstance.get<T>(path, config);
  }
}

