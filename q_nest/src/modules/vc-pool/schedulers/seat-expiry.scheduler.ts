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
      const now = new Date();
      this.logger.log(`[SCHEDULER] Checking for expired reservations at ${now.toISOString()}`);

      // Find expired 'reserved' status reservations
      const expiredReservations = await this.prisma.vc_pool_seat_reservations.findMany({
        where: {
          status: 'reserved' as any,
          expires_at: { lt: now },
        },
      });

      if (expiredReservations.length === 0) {
        this.isRunning = false;
        return;
      }

      this.logger.log(`[SCHEDULER] Found ${expiredReservations.length} expired reservation(s). Deleting...`);

      for (const reservation of expiredReservations) {
        try {
          this.logger.log(`[SCHEDULER] Processing reservation ${reservation.reservation_id}`);

          // Delete in a transaction
          await this.prisma.$transaction(async (tx) => {
            // 1. Delete payment submissions
            await tx.vc_pool_payment_submissions.deleteMany({
              where: {
                pool_id: reservation.pool_id,
                user_id: reservation.user_id,
              },
            });
            this.logger.log(`  ✓ Deleted payment record`);

            // 2. Delete seat reservation
            await tx.vc_pool_seat_reservations.deleteMany({
              where: {
                pool_id: reservation.pool_id,
                user_id: reservation.user_id,
              },
            });
            this.logger.log(`  ✓ Deleted seat reservation`);

            // 3. Delete member
            await tx.vc_pool_members.deleteMany({
              where: {
                pool_id: reservation.pool_id,
                user_id: reservation.user_id,
              },
            });
            this.logger.log(`  ✓ Deleted member record`);

            // 4. Decrement reserved seats
            await tx.vc_pools.update({
              where: { pool_id: reservation.pool_id },
              data: { reserved_seats_count: { decrement: 1 } },
            });
            this.logger.log(`  ✓ Decremented reserved_seats_count`);
          });

          this.logger.log(`[SCHEDULER] ✓ Successfully deleted expired reservation ${reservation.reservation_id}`);
        } catch (err) {
          this.logger.error(`[SCHEDULER] Error processing reservation ${reservation.reservation_id}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[SCHEDULER] Error: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

