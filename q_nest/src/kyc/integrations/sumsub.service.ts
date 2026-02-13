import { Injectable, Logger, HttpException, HttpStatus, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as crypto from 'crypto';
import FormData = require('form-data');
import * as countries from 'i18n-iso-countries';

interface SumsubConfig {
  appToken: string;
  secretKey: string;
  baseUrl: string;
  levelName: string;
  webhookSecret: string;
}

interface SumsubApplicant {
  id: string;
  externalUserId: string;
  createdAt: string;
  review?: {
    reviewStatus: string;
    reviewResult?: {
      reviewAnswer: string;
      rejectLabels?: string[];
      reviewRejectType?: string;
      moderationComment?: string;
      clientComment?: string;
    };
  };
}

interface SumsubDocumentResponse {
  documentId: string;
  applicantId: string;
  imageIds: string[];
}

interface SumsubReviewResult {
  reviewAnswer: string; // GREEN, RED, YELLOW
  reviewRejectType?: string;
  reviewStatus: string; // init, pending, completed, onHold
  moderationComment?: string;
  clientComment?: string;
}

@Injectable()
export class SumsubService implements OnModuleInit {
  /**
   * Convert a nationality/country name or code to ISO 3166-1 alpha-3 code for Sumsub.
   * Handles: full names ("United States of America"), alpha-2 ("US"), alpha-3 ("USA")
   */
  private convertToAlpha3(nationality: string): string {
    if (!nationality) return 'USA'; // fallback

    const trimmed = nationality.trim();

    // Already alpha-3? (3 uppercase letters)
    if (/^[A-Z]{3}$/.test(trimmed)) {
      // Validate it's a real alpha-3 code
      if (countries.isValid(trimmed)) return trimmed;
    }

    // Alpha-2 code? (2 uppercase letters)
    if (/^[A-Z]{2}$/i.test(trimmed)) {
      const alpha3 = countries.alpha2ToAlpha3(trimmed.toUpperCase());
      if (alpha3) return alpha3;
    }

    // Try as country name → alpha-2 → alpha-3
    const alpha2 = countries.getAlpha2Code(trimmed, 'en');
    if (alpha2) {
      const alpha3 = countries.alpha2ToAlpha3(alpha2);
      if (alpha3) return alpha3;
    }

    this.logger.warn(`Could not convert nationality "${nationality}" to alpha-3, falling back to USA`);
    return 'USA';
  }

  private readonly logger = new Logger(SumsubService.name);
  private readonly config: SumsubConfig;
  private readonly axiosInstance: AxiosInstance;

  onModuleInit() {
    // Register English locale for country name lookups
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
  }

  constructor(private configService: ConfigService) {
    this.config = {
      appToken: this.configService.get<string>('kyc.sumsub.appToken'),
      secretKey: this.configService.get<string>('kyc.sumsub.secretKey'),
      baseUrl: this.configService.get<string>('kyc.sumsub.baseUrl'),
      levelName: this.configService.get<string>('kyc.sumsub.levelName'),
      webhookSecret: this.configService.get<string>('kyc.sumsub.webhookSecret'),
    };

    if (!this.config.appToken || !this.config.secretKey) {
      this.logger.warn('Sumsub credentials not configured. Service will not function.');
    }

    // Log configuration on startup
    this.logger.log('Sumsub Service Initialized');
    this.logger.log(`Base URL: ${this.config.baseUrl}`);
    this.logger.log(`Level Name: ${this.config.levelName || 'NOT SET'}`);
    this.logger.log(`App Token: ${this.config.appToken ? this.config.appToken.substring(0, 15) + '...' : 'NOT SET'}`);

    this.axiosInstance = axios.create({
      baseURL: this.config.baseUrl,
      timeout: 30000,
    });
  }

  /**
   * Generate HMAC signature for Sumsub API authentication
   * Format: HMAC-SHA256(secret, timestamp + method + url + body)
   */
  private generateSignature(
    method: string,
    url: string,
    timestamp: number,
    body?: string | Buffer,
  ): string {
    const hmac = crypto.createHmac('sha256', this.config.secretKey);
    hmac.update(timestamp + method.toUpperCase() + url);
    
    if (body) {
      hmac.update(body);
    }
    
    const signature = hmac.digest('hex');
    this.logger.debug(`Generated signature: ${signature}`);
    return signature;
  }

  /**
   * Make authenticated request with FormData using axios
   * Key: signature MUST include FormData buffer (per official Sumsub examples)
   */
  private async makeFormDataRequest<T>(
    method: string,
    path: string,
    formData: FormData,
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // CRITICAL: Include FormData buffer in signature calculation!
    const buffer = formData.getBuffer();
    const signature = this.generateSignature(method, path, timestamp, buffer);
    
    const headers = {
      'Accept': 'application/json',
      'X-App-Token': this.config.appToken,
      'X-App-Access-Ts': timestamp.toString(),
      'X-App-Access-Sig': signature,
      ...formData.getHeaders(),
    };

    this.logger.debug(`FormData request: ${method} ${path}`);
    this.logger.debug(`Buffer length: ${buffer.length}`);

    try {
      const response = await this.axiosInstance.request<T>({
        method,
        url: path,
        headers,
        data: formData,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      this.logger.log(`✅ Sumsub file upload successful`);
      return response.data;
    } catch (error) {
      this.logger.error(
        `Sumsub API error: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`,
      );
      throw new HttpException(
        error.response?.data?.description || 'Sumsub API request failed',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Make authenticated request to Sumsub API
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    data?: any,
    isFormData = false,
  ): Promise<T> {
    // Use native HTTPS for FormData to avoid axios issues
    if (isFormData && data) {
      return this.makeFormDataRequest<T>(method, path, data);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const url = path;

    // For JSON, include the exact body that will be sent
    let bodyForSignature = '';
    let requestBody: any = undefined;
    
    if (data) {
      // Use compact JSON (no extra spaces) - exactly as it will be sent
      bodyForSignature = JSON.stringify(data);
      requestBody = bodyForSignature; // Send as string to ensure exact match
    }

    this.logger.debug(`Request details: method=${method}, url=${url}, timestamp=${timestamp}`);
    this.logger.debug(`Body for signature: ${bodyForSignature || '(empty)'}`);

    const signature = this.generateSignature(method, url, timestamp, bodyForSignature);

    const headers: any = {
      'X-App-Token': this.config.appToken,
      'X-App-Access-Ts': timestamp.toString(),
      'X-App-Access-Sig': signature,
    };

    if (data) {
      headers['Content-Type'] = 'application/json';
    }

    const config: AxiosRequestConfig = {
      method,
      url,
      headers,
      data: requestBody,
    };

    try {
      this.logger.debug(`Sumsub API request: ${method} ${path}`);
      const response = await this.axiosInstance.request<T>(config);
      return response.data;
    } catch (error) {
      this.logger.error(
        `Sumsub API error: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`,
      );
      throw new HttpException(
        error.response?.data?.description || 'Sumsub API request failed',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Create a new applicant in Sumsub
   */
  async createApplicant(
    externalUserId: string,
    email?: string,
    phone?: string,
  ): Promise<SumsubApplicant> {
    this.logger.log(`Creating Sumsub applicant for user: ${externalUserId}`);
    this.logger.debug(`Sumsub Config - Level Name: ${this.config.levelName}`);
    this.logger.debug(`Sumsub Config - Base URL: ${this.config.baseUrl}`);
    this.logger.debug(`Sumsub Config - App Token: ${this.config.appToken?.substring(0, 15)}...`);

    // levelName must be a QUERY PARAMETER, not in the body!
    const payload: any = {
      externalUserId,
    };

    if (email) {
      payload.email = email;
    }
    if (phone) {
      payload.phone = phone;
    }

    this.logger.debug(`Create applicant payload: ${JSON.stringify(payload)}`);

    // Add levelName as query parameter in URL
    const url = `/resources/applicants?levelName=${encodeURIComponent(this.config.levelName)}`;
    
    return this.makeRequest<SumsubApplicant>('POST', url, payload);
  }

  /**
   * Get applicant by external user ID
   */
  async getApplicantByExternalUserId(externalUserId: string): Promise<SumsubApplicant | null> {
    try {
      const response = await this.makeRequest<SumsubApplicant>(
        'GET',
        `/resources/applicants/-;externalUserId=${externalUserId}/one`,
      );
      return response;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get applicant status by applicant ID
   */
  async getApplicantStatus(applicantId: string): Promise<SumsubApplicant> {
    this.logger.log(`Fetching applicant status: ${applicantId}`);
    return this.makeRequest<SumsubApplicant>('GET', `/resources/applicants/${applicantId}/one`);
  }

  /**
   * Get required document status for applicant (shows what's missing/rejected per doc type)
   */
  async getRequiredDocStatus(applicantId: string): Promise<any> {
    this.logger.log(`Fetching required docs status: ${applicantId}`);
    return this.makeRequest<any>('GET', `/resources/applicants/${applicantId}/requiredIdDocsStatus`);
  }

  /**
   * Add document to applicant
   */
  async addDocument(
    applicantId: string,
    fileBuffer: Buffer,
    filename: string,
    documentType: string = 'IDENTITY',
    country?: string,
  ): Promise<SumsubDocumentResponse> {
    const alpha3Country = this.convertToAlpha3(country || '');
    this.logger.log(`Adding document to applicant: ${applicantId}, country: ${alpha3Country}`);

    const formData = new FormData();
    
    const metadata = {
      idDocType: documentType,
      country: alpha3Country,
    };
    formData.append('metadata', JSON.stringify(metadata));
    
    formData.append('content', fileBuffer, {
      filename,
      contentType: this.getContentType(filename),
    });

    return this.makeRequest<SumsubDocumentResponse>(
      'POST',
      `/resources/applicants/${applicantId}/info/idDoc`,
      formData,
      true,
    );
  }

  /**
   * Upload selfie image (selfie is a document type in Sumsub)
   */
  async uploadSelfie(applicantId: string, fileBuffer: Buffer, filename: string, country?: string): Promise<any> {
    const alpha3Country = this.convertToAlpha3(country || '');
    this.logger.log(`Uploading selfie for applicant: ${applicantId}, country: ${alpha3Country}`);

    const formData = new FormData();
    
    const metadata = {
      idDocType: 'SELFIE',
      country: alpha3Country,
    };
    formData.append('metadata', JSON.stringify(metadata));
    
    formData.append('content', fileBuffer, {
      filename,
      contentType: this.getContentType(filename),
    });

    return this.makeRequest<any>(
      'POST',
      `/resources/applicants/${applicantId}/info/idDoc`,
      formData,
      true,
    );
  }

  /**
   * Request verification check for applicant
   */
  async requestCheck(applicantId: string): Promise<any> {
    this.logger.log(`Requesting verification check for applicant: ${applicantId}`);
    return this.makeRequest<any>('POST', `/resources/applicants/${applicantId}/status/pending`);
  }

  /**
   * Generate access token for SDK (optional, for future use)
   */
  async generateAccessToken(
    externalUserId: string,
    levelName?: string,
    ttlInSecs: number = 600,
  ): Promise<{ token: string; userId: string }> {
    const payload = {
      externalUserId,
      levelName: levelName || this.config.levelName,
      ttlInSecs,
    };

    return this.makeRequest<{ token: string; userId: string }>(
      'POST',
      '/resources/accessTokens',
      payload,
    );
  }

  /**
   * Reset applicant (for resubmission)
   */
  async resetApplicant(applicantId: string): Promise<any> {
    this.logger.log(`Resetting applicant: ${applicantId}`);
    return this.makeRequest<any>('POST', `/resources/applicants/${applicantId}/reset`);
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  /**
   * Parse webhook review result to KYC status
   */
  parseReviewResult(reviewAnswer: string): 'approved' | 'rejected' | 'review' {
    switch (reviewAnswer) {
      case 'GREEN':
        return 'approved';
      case 'RED':
        return 'rejected';
      case 'YELLOW':
        return 'review';
      default:
        return 'review';
    }
  }

  /**
   * Get content type from filename
   */
  private getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      pdf: 'application/pdf',
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}
