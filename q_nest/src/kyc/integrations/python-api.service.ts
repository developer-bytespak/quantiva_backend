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
      timeout: 30000,
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
    } catch (error) {
      this.logger.error('OCR request failed', error);
      throw new Error('OCR processing failed');
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
    } catch (error) {
      this.logger.error('Liveness verification failed', error);
      throw new Error('Liveness verification failed');
    }
  }

  async matchFaces(
    idPhotoBuffer: Buffer,
    selfieBuffer: Buffer,
    idPhotoFilename: string,
    selfieFilename: string,
  ): Promise<FaceMatchResponse> {
    try {
      const formData = new FormData();
      formData.append('id_photo', idPhotoBuffer, idPhotoFilename);
      formData.append('selfie', selfieBuffer, selfieFilename);

      const response = await this.axiosInstance.post<FaceMatchResponse>(
        '/api/v1/kyc/face-match',
        formData,
        {
          headers: formData.getHeaders(),
        },
      );

      return response.data;
    } catch (error) {
      this.logger.error('Face matching failed', error);
      throw new Error('Face matching failed');
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
    } catch (error) {
      this.logger.error('Document authenticity check failed', error);
      throw new Error('Document authenticity check failed');
    }
  }
}

