import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

export interface CloudinaryUploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private isConfigured = false;

  constructor(private configService: ConfigService) {
    this.configureCloudinary();
  }

  private configureCloudinary(): void {
    const cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');

    if (!cloudName || !apiKey || !apiSecret) {
      this.logger.warn('Cloudinary credentials not fully configured. Cloud storage will not work.');
      return;
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });

    this.isConfigured = true;
    this.logger.log(`Cloudinary configured with cloud: ${cloudName}`);
  }

  /**
   * Upload a file buffer to Cloudinary
   * @param buffer File buffer to upload
   * @param folder Folder path in Cloudinary (e.g., 'kyc/documents')
   * @param filename Optional filename for reference
   * @returns Upload result with URL and metadata
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename?: string,
  ): Promise<CloudinaryUploadResult> {
    if (!this.isConfigured) {
      throw new Error('Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('Cannot upload empty buffer');
    }

    this.logger.debug(`Uploading to Cloudinary - Folder: ${folder}, Size: ${buffer.length} bytes`);

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: folder,
          resource_type: 'image',
          // Generate a unique public_id based on timestamp
          public_id: `${Date.now()}_${filename?.replace(/\.[^/.]+$/, '') || 'file'}`,
          // Optimize for KYC - keep quality but reasonable size
          transformation: [
            { quality: 'auto:good' },
            { fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) {
            this.logger.error(`Cloudinary upload failed: ${error.message}`);
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
            return;
          }

          if (!result) {
            reject(new Error('Cloudinary upload returned no result'));
            return;
          }

          this.logger.debug(`Cloudinary upload successful: ${result.secure_url}`);

          resolve({
            url: result.url,
            secureUrl: result.secure_url,
            publicId: result.public_id,
            format: result.format,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
          });
        },
      );

      // Convert buffer to stream and pipe to Cloudinary
      const readableStream = new Readable();
      readableStream.push(buffer);
      readableStream.push(null);
      readableStream.pipe(uploadStream);
    });
  }

  /**
   * Upload a Multer file to Cloudinary
   * @param file Multer file object
   * @param folder Folder path in Cloudinary
   * @returns Upload result with URL and metadata
   */
  async uploadFile(
    file: Express.Multer.File,
    folder: string,
  ): Promise<CloudinaryUploadResult> {
    if (!file.buffer || file.buffer.length === 0) {
      throw new Error(`File buffer is empty for file: ${file.originalname}`);
    }

    return this.uploadBuffer(file.buffer, folder, file.originalname);
  }

  /**
   * Fetch an image from Cloudinary URL and return as Buffer
   * @param url Cloudinary URL (secure or regular)
   * @returns Image buffer
   */
  async fetchImageBuffer(url: string): Promise<Buffer> {
    if (!url) {
      throw new Error('URL is required to fetch image');
    }

    this.logger.debug(`Fetching image from Cloudinary: ${url}`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch image: HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length === 0) {
        throw new Error('Fetched image is empty');
      }

      this.logger.debug(`Successfully fetched image: ${buffer.length} bytes`);
      return buffer;
    } catch (error: any) {
      this.logger.error(`Failed to fetch image from ${url}: ${error.message}`);
      throw new Error(`Failed to fetch image from Cloudinary: ${error.message}`);
    }
  }

  /**
   * Extract public ID from Cloudinary URL
   * @param url Full Cloudinary URL
   * @returns Public ID or null if not a valid Cloudinary URL
   */
  extractPublicIdFromUrl(url: string): string | null {
    if (!url || !url.includes('cloudinary.com')) {
      return null;
    }

    try {
      // Cloudinary URL format: https://res.cloudinary.com/{cloud_name}/image/upload/v{version}/{public_id}.{format}
      // Example: https://res.cloudinary.com/djqmhkla6/image/upload/v1770067306/quantiva/kyc/documents/1770067295432_file.jpg
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (match && match[1]) {
        // Decode URL-encoded characters and return public ID
        return decodeURIComponent(match[1]);
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to extract public ID from URL: ${url}`);
      return null;
    }
  }

  /**
   * Delete an image from Cloudinary by URL
   * @param url Full Cloudinary URL
   */
  async deleteByUrl(url: string): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn('Cloudinary not configured, skipping delete');
      return false;
    }

    const publicId = this.extractPublicIdFromUrl(url);
    if (!publicId) {
      this.logger.warn(`Not a Cloudinary URL, cannot delete: ${url}`);
      return false;
    }

    try {
      await cloudinary.uploader.destroy(publicId);
      this.logger.debug(`Deleted image from Cloudinary: ${publicId}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to delete Cloudinary image ${publicId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete an image from Cloudinary by public ID
   * @param publicId Cloudinary public ID
   */
  async deleteImage(publicId: string): Promise<void> {
    if (!this.isConfigured) {
      this.logger.warn('Cloudinary not configured, skipping delete');
      return;
    }

    try {
      await cloudinary.uploader.destroy(publicId);
      this.logger.debug(`Deleted image from Cloudinary: ${publicId}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete image ${publicId}: ${error.message}`);
      // Don't throw - deletion failure shouldn't break the flow
    }
  }

  /**
   * Check if Cloudinary is properly configured
   */
  isCloudinaryConfigured(): boolean {
    return this.isConfigured;
  }
}
