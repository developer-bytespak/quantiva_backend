import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import {
  DocumentAuthenticityResponse,
  FaceMatchResponse,
  LivenessResponse,
  OCRResponse,
} from './interfaces/python-api.interface';

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

  async performOCR(imageBuffer: Buffer, filename: string): Promise<OCRResponse> {
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, filename);

      const response = await this.axiosInstance.post<OCRResponse>(
        '/api/v1/kyc/ocr',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('OCR request failed', {
        message: error?.message,
        code: error?.code,
        response: error?.response?.data,
        status: error?.response?.status,
        baseUrl: this.baseUrl,
      });
      
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Cannot connect to Python API at ${this.baseUrl}. Make sure the Python FastAPI server is running on port 8000.`
        );
      }
      
      if (error?.response?.data?.detail) {
        throw new Error(`OCR processing failed: ${error.response.data.detail}`);
      }
      
      throw new Error(`OCR processing failed: ${error?.message || 'Unknown error'}`);
    }
  }

  async verifyLiveness(imageBuffer: Buffer, filename: string): Promise<LivenessResponse> {
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, filename);

      const response = await this.axiosInstance.post<LivenessResponse>(
        '/api/v1/kyc/liveness',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('Liveness verification failed', {
        message: error?.message,
        code: error?.code,
        response: error?.response?.data,
        status: error?.response?.status,
        baseUrl: this.baseUrl,
      });
      
      // Provide more detailed error message
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Cannot connect to Python API at ${this.baseUrl}. Make sure the Python FastAPI server is running on port 8000.`
        );
      }
      
      if (error?.response?.data?.detail) {
        throw new Error(`Liveness verification failed: ${error.response.data.detail}`);
      }
      
      throw new Error(`Liveness verification failed: ${error?.message || 'Unknown error'}`);
    }
  }

  async matchFaces(
    idPhotoBuffer: Buffer,
    selfieBuffer: Buffer,
    idPhotoFilename: string,
    selfieFilename: string,
  ): Promise<FaceMatchResponse> {
    const startTime = Date.now();
    this.logger.log('--------------------------------------------------------------');
    this.logger.log(`🐍 [PYTHON-API] Calling POST ${this.baseUrl}/api/v1/kyc/face-match`);
    this.logger.log(`   ID photo: ${idPhotoBuffer.length} bytes, Selfie: ${selfieBuffer.length} bytes`);
    
    try {
      const formData = new FormData();
      formData.append('id_photo', idPhotoBuffer, idPhotoFilename);
      formData.append('selfie', selfieBuffer, selfieFilename);

      this.logger.log(`   FormData prepared, sending request...`);
      const requestStart = Date.now();
      
      // Extended timeout for face matching (5 minutes) - embedding + comparison is CPU intensive
      const response = await this.axiosInstance.post<FaceMatchResponse>(
        '/api/v1/kyc/face-match',
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 300000, // 5 minutes for face matching
        },
      );

      const responseTime = Date.now() - requestStart;
      const totalTime = Date.now() - startTime;
      this.logger.log(`   ✅ Response received in ${responseTime}ms`);
      this.logger.log(`   Total API call time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
      this.logger.log('--------------------------------------------------------------');

      return response.data;
    } catch (error: any) {
      const totalTime = Date.now() - startTime;
      this.logger.error(`   ❌ Request FAILED after ${totalTime}ms`);
      this.logger.error('Face matching failed', {
        message: error?.message,
        code: error?.code,
        response: error?.response?.data,
        status: error?.response?.status,
        baseUrl: this.baseUrl,
      });
      
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Cannot connect to Python API at ${this.baseUrl}. Make sure the Python FastAPI server is running on port 8000.`
        );
      }
      
      if (error?.response?.data?.detail) {
        throw new Error(`Face matching failed: ${error.response.data.detail}`);
      }
      
      throw new Error(`Face matching failed: ${error?.message || 'Unknown error'}`);
    }
  }

  async checkDocumentAuthenticity(
    imageBuffer: Buffer,
    filename: string,
  ): Promise<DocumentAuthenticityResponse> {
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, filename);

      const response = await this.axiosInstance.post<DocumentAuthenticityResponse>(
        '/api/v1/kyc/document-authenticity',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('Document authenticity check failed', {
        message: error?.message,
        code: error?.code,
        response: error?.response?.data,
        status: error?.response?.status,
        baseUrl: this.baseUrl,
      });
      
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Cannot connect to Python API at ${this.baseUrl}. Make sure the Python FastAPI server is running on port 8000.`
        );
      }
      
      if (error?.response?.data?.detail) {
        throw new Error(`Document authenticity check failed: ${error.response.data.detail}`);
      }
      
      throw new Error(`Document authenticity check failed: ${error?.message || 'Unknown error'}`);
    }
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

