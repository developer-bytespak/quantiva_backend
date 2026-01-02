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
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 150000, // 2.5 minutes - 120s for face matching + 30s buffer for I/O
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
    try {
      const startTime = Date.now();
      this.logger.log(`[FACE_MATCH_START] Initializing face matching: ID photo=${idPhotoFilename} (${idPhotoBuffer.length} bytes), Selfie=${selfieFilename} (${selfieBuffer.length} bytes)`);
      
      const formData = new FormData();
      formData.append('id_photo', idPhotoBuffer, idPhotoFilename);
      formData.append('selfie', selfieBuffer, selfieFilename);

      this.logger.log(`[FACE_MATCH_SENDING] Sending request to Python API at ${this.baseUrl}/api/v1/kyc/face-match`);
      const response = await this.axiosInstance.post<FaceMatchResponse>(
        '/api/v1/kyc/face-match',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      const elapsedTime = Date.now() - startTime;
      this.logger.log(`[FACE_MATCH_SUCCESS] Face matching completed in ${elapsedTime}ms. Result: similarity=${response.data.similarity}, is_match=${response.data.is_match}, confidence=${response.data.confidence}`);
      
      return response.data;
    } catch (error: any) {
      const elapsedTime = Date.now() - (error.startTime || Date.now());
      this.logger.error(`[FACE_MATCH_ERROR] Face matching failed after ${elapsedTime}ms`, {
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

