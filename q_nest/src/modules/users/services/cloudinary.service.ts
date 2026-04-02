import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class CloudinaryService {
  constructor(private configService: ConfigService) {
    // Initialize Cloudinary with config values
    cloudinary.config({
      cloud_name: this.configService.get<string>('cloudinary.cloudName'),
      api_key: this.configService.get<string>('cloudinary.apiKey'),
      api_secret: this.configService.get<string>('cloudinary.apiSecret'),
    });
  }

  /**
   * Extract the Cloudinary public_id from a secure_url so we can delete it.
   * e.g. "https://res.cloudinary.com/.../profile_pictures/abc123.jpg" → "profile_pictures/abc123"
   */
  private extractPublicId(url: string): string | null {
    try {
      const match = url.match(/\/upload\/(?:v\d+\/)?(.*?)(?:\.\w+)?$/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async deleteImage(imageUrl: string): Promise<void> {
    const publicId = this.extractPublicId(imageUrl);
    if (!publicId) return;
    await cloudinary.uploader.destroy(publicId);
  }

  async uploadImage(file: Express.Multer.File): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'profile_pictures',
          resource_type: 'image',
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else if (result) {
            resolve(result.secure_url);
          } else {
            reject(new Error('Upload failed: No result returned'));
          }
        },
      );

      // Upload the file buffer
      uploadStream.end(file.buffer);
    });
  }
}

