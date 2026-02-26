import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CloudinaryService } from '../../../storage/cloudinary.service';

@Injectable()
export class ScreenshotUploadService {
  private readonly logger = new Logger(ScreenshotUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async uploadScreenshot(
    userId: string,
    poolId: string,
    file: Express.Multer.File,
  ) {
    const reservation = await this.prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
    });

    if (!reservation) {
      throw new NotFoundException('No reservation found for this pool');
    }

    if (reservation.status !== 'reserved') {
      throw new BadRequestException(
        `Reservation is ${reservation.status}, not eligible for screenshot upload`,
      );
    }

    if (new Date() >= reservation.expires_at) {
      throw new BadRequestException('Reservation has expired. Please join again.');
    }

    if (reservation.payment_method !== 'binance') {
      throw new BadRequestException('Screenshot upload is only for Binance payments');
    }

    const submission = await this.prisma.vc_pool_payment_submissions.findFirst({
      where: { reservation_id: reservation.reservation_id },
    });

    if (!submission) {
      throw new NotFoundException('Payment submission not found');
    }

    if (submission.status !== 'pending') {
      throw new BadRequestException(
        `Payment is ${submission.status}, cannot upload screenshot`,
      );
    }

    // Upload to Cloudinary
    const uploadResult = await this.cloudinary.uploadFile(
      file,
      'quantiva/vc-pool/payment-screenshots',
    );

    // Update submission with screenshot URL and move to processing
    await this.prisma.vc_pool_payment_submissions.update({
      where: { submission_id: submission.submission_id },
      data: {
        screenshot_url: uploadResult.secureUrl,
        status: 'processing' as any,
      },
    });

    this.logger.log(
      `Screenshot uploaded for pool ${poolId} by user ${userId}: ${uploadResult.secureUrl}`,
    );

    return {
      message: 'Screenshot uploaded successfully. Awaiting admin approval.',
      submission_id: submission.submission_id,
      screenshot_url: uploadResult.secureUrl,
    };
  }
}
