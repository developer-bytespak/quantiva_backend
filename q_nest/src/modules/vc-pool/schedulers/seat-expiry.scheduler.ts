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
          payment_submission: { 
            select: { 
              submission_id: true, 
              status: true,
              total_amount: true,
              investment_amount: true,
              pool_fee_amount: true,
              user_id: true,
              binance_payment_status: true,
            } 
          },
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
            // 1. Expire the reservation
            await tx.vc_pool_seat_reservations.update({
              where: { reservation_id: reservation.reservation_id },
              data: { status: 'expired' as any },
            });

            // 2. Decrement reserved seats
            await tx.vc_pools.update({
              where: { pool_id: reservation.pool_id },
              data: { reserved_seats_count: { decrement: 1 } },
            });

            // 3. Expire related payment submission if pending/processing
            if (
              reservation.payment_submission &&
              (reservation.payment_submission.status === 'pending' ||
                reservation.payment_submission.status === 'processing')
            ) {
              const submission = reservation.payment_submission;

              // Update payment submission to expired
              await tx.vc_pool_payment_submissions.update({
                where: { submission_id: submission.submission_id },
                data: {
                  status: 'expired' as any,
                  binance_payment_status: 'expired' as any,
                  refund_initiated_at: new Date(),
                  refund_reason: 'Seat reservation timer expired - payment not completed within allocated time',
                },
              });

              // 4. NEW: Create refund transaction record
              await tx.vc_pool_transactions.create({
                data: {
                  pool_id: reservation.pool_id,
                  user_id: submission.user_id,
                  payment_submission_id: submission.submission_id,
                  transaction_type: 'payment_expired_refund_initiated',
                  amount_usdt: submission.total_amount,
                  status: 'pending', // Waiting for admin or auto-refund processing
                  description: `Payment reservation expired after ${reservation.expires_at}. Refund initiated. Amount: ${submission.total_amount} USDT (Investment: ${submission.investment_amount}, Fee: ${submission.pool_fee_amount})`,
                  created_at: new Date(),
                },
              });

              this.logger.log(
                `Expired payment submission ${submission.submission_id} for user ${submission.user_id} - refund initiated`,
              );
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
