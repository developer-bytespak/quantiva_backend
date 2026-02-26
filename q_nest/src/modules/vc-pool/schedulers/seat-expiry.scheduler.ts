import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class SeatExpiryScheduler {
  private readonly logger = new Logger(SeatExpiryScheduler.name);
  private isRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/30 * * * * *') // Every 30 seconds
  async handleSeatExpiry() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const expiredReservations = await this.prisma.vc_pool_seat_reservations.findMany({
        where: {
          status: 'reserved' as any,
          expires_at: { lt: new Date() },
        },
        include: {
          payment_submission: { select: { submission_id: true, status: true } },
        },
      });

      if (expiredReservations.length === 0) {
        this.isRunning = false;
        return;
      }

      this.logger.log(`Found ${expiredReservations.length} expired seat reservation(s)`);

      for (const reservation of expiredReservations) {
        try {
          await this.prisma.$transaction(async (tx) => {
            // Expire the reservation
            await tx.vc_pool_seat_reservations.update({
              where: { reservation_id: reservation.reservation_id },
              data: { status: 'expired' as any },
            });

            // Decrement reserved seats
            await tx.vc_pools.update({
              where: { pool_id: reservation.pool_id },
              data: { reserved_seats_count: { decrement: 1 } },
            });

            // Expire related payment submission if pending/processing
            if (
              reservation.payment_submission &&
              (reservation.payment_submission.status === 'pending' ||
                reservation.payment_submission.status === 'processing')
            ) {
              await tx.vc_pool_payment_submissions.update({
                where: { submission_id: reservation.payment_submission.submission_id },
                data: { status: 'expired' as any },
              });
            }
          });

          this.logger.log(
            `Expired reservation ${reservation.reservation_id} for pool ${reservation.pool_id}`,
          );
        } catch (err) {
          this.logger.error(
            `Failed to expire reservation ${reservation.reservation_id}: ${err.message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Seat expiry job failed: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
