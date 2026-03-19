import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';

/** 0.1 % fee on every executed top-trade */
const FEE_PERCENT = 0.001;

/** Stripe rejects invoice items below $0.50 */
const MIN_INVOICE_AMOUNT = 0.5;

@Injectable()
export class TradeFeesService {
  private readonly logger = new Logger(TradeFeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => StripeService))
    private readonly stripeService: StripeService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────

  private currentBillingMonth(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // ─── Record a fee after trade execution ─────────────────────────────

  async recordTradeFee(params: {
    userId: string;
    tradeReferenceId?: string;
    assetSymbol: string;
    tradeSide: string;
    tradeValueUsd: number;
    source?: 'top_trade_crypto' | 'top_trade_stock';
  }): Promise<void> {
    const feeAmount = params.tradeValueUsd * FEE_PERCENT;
    const billingMonth = this.currentBillingMonth();

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Create fee record
        await tx.trade_fees.create({
          data: {
            user_id: params.userId,
            trade_reference_id: params.tradeReferenceId ?? null,
            asset_symbol: params.assetSymbol,
            trade_side: params.tradeSide,
            trade_value_usd: params.tradeValueUsd,
            fee_percent: FEE_PERCENT,
            fee_amount_usd: feeAmount,
            source: params.source ?? 'top_trade_crypto',
            billing_month: billingMonth,
          },
        });

        // 2. Upsert monthly summary
        await tx.monthly_fee_summaries.upsert({
          where: {
            user_id_billing_month: {
              user_id: params.userId,
              billing_month: billingMonth,
            },
          },
          create: {
            user_id: params.userId,
            billing_month: billingMonth,
            total_trades: 1,
            total_trade_volume_usd: params.tradeValueUsd,
            total_fees_usd: feeAmount,
          },
          update: {
            total_trades: { increment: 1 },
            total_trade_volume_usd: { increment: params.tradeValueUsd },
            total_fees_usd: { increment: feeAmount },
          },
        });
      });

      this.logger.debug(
        `Fee recorded: $${feeAmount.toFixed(6)} for ${params.assetSymbol} (${params.tradeSide}) user=${params.userId}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to record trade fee: ${err.message}`);
    }
  }

  // ─── Monthly billing cron (1st of each month, 00:05 UTC) ───────────

  @Cron('0 5 0 1 * *', { name: 'monthly-trade-fee-billing' })
  async processMonthlyBilling(): Promise<void> {
    // Bill the *previous* month
    const now = new Date();
    const prev = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const billingMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

    this.logger.log(`Starting monthly trade-fee billing for ${billingMonth}`);

    const summaries = await this.prisma.monthly_fee_summaries.findMany({
      where: { billing_month: billingMonth, status: 'accumulating' },
      include: { user: { select: { user_id: true, stripe_customer_id: true, email: true } } },
    });

    if (!summaries.length) {
      this.logger.log('No pending summaries to bill.');
      return;
    }

    for (const summary of summaries) {
      await this.invoiceUser(summary, billingMonth);
    }

    this.logger.log(`Billing complete: processed ${summaries.length} users for ${billingMonth}`);
  }

  private async invoiceUser(summary: any, billingMonth: string): Promise<void> {
    const totalFees = Number(summary.total_fees_usd);
    const userId = summary.user_id;

    // Below minimum → carry forward
    if (totalFees < MIN_INVOICE_AMOUNT) {
      await this.prisma.monthly_fee_summaries.update({
        where: { summary_id: summary.summary_id },
        data: { status: 'below_minimum' },
      });
      this.logger.log(`User ${userId}: $${totalFees.toFixed(4)} below minimum, skipping invoice.`);
      return;
    }

    try {
      // Ensure Stripe customer exists
      let customerId = summary.user?.stripe_customer_id;
      if (!customerId) {
        const customer = await this.stripeService.createCustomer(
          summary.user.email,
          userId,
        );
        customerId = customer.id;
        await this.prisma.users.update({
          where: { user_id: userId },
          data: { stripe_customer_id: customerId },
        });
      }

      // Create invoice item + invoice
      await this.stripeService.createInvoiceItem({
        customerId,
        amountCents: Math.round(totalFees * 100),
        description: `Quantiva top-trade fees — ${billingMonth} (${summary.total_trades} trades)`,
        metadata: { user_id: userId, billing_month: billingMonth },
      });

      const invoice = await this.stripeService.createAndFinalizeInvoice({
        customerId,
        autoAdvance: true,
        metadata: {
          user_id: userId,
          billing_month: billingMonth,
          total_trades: String(summary.total_trades),
        },
      });

      const isPaid = invoice.status === 'paid';

      // Persist
      await this.prisma.$transaction([
        this.prisma.monthly_fee_summaries.update({
          where: { summary_id: summary.summary_id },
          data: {
            status: isPaid ? 'paid' : 'invoiced',
            stripe_invoice_id: invoice.id,
            paid_at: isPaid ? new Date() : null,
          },
        }),
        this.prisma.trade_fees.updateMany({
          where: { user_id: userId, billing_month: billingMonth, status: 'pending' },
          data: { status: isPaid ? 'paid' : 'invoiced' },
        }),
      ]);

      this.logger.log(
        `Invoice ${invoice.id} created for user ${userId}: $${totalFees.toFixed(2)} — ${isPaid ? 'paid' : 'invoiced'}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to invoice user ${userId}: ${err.message}`);
      await this.prisma.monthly_fee_summaries.update({
        where: { summary_id: summary.summary_id },
        data: { status: 'failed' },
      });
    }
  }

  // ─── Daily retry for failed invoices (06:00 UTC) ───────────────────

  @Cron('0 0 6 * * *', { name: 'retry-failed-trade-fee-invoices' })
  async retryFailedInvoices(): Promise<void> {
    const failed = await this.prisma.monthly_fee_summaries.findMany({
      where: { status: 'failed' },
      include: { user: { select: { user_id: true, stripe_customer_id: true, email: true } } },
    });

    if (!failed.length) return;
    this.logger.log(`Retrying ${failed.length} failed invoices…`);

    for (const summary of failed) {
      if (summary.stripe_invoice_id) {
        try {
          const invoice = await this.stripeService.payInvoice(summary.stripe_invoice_id);
          if (invoice.status === 'paid') {
            await this.prisma.$transaction([
              this.prisma.monthly_fee_summaries.update({
                where: { summary_id: summary.summary_id },
                data: { status: 'paid', paid_at: new Date() },
              }),
              this.prisma.trade_fees.updateMany({
                where: {
                  user_id: summary.user_id,
                  billing_month: summary.billing_month,
                  status: { in: ['invoiced', 'failed'] },
                },
                data: { status: 'paid' },
              }),
            ]);
            this.logger.log(`Retry OK: user ${summary.user_id}, month ${summary.billing_month}`);
          }
        } catch (err: any) {
          this.logger.warn(`Retry failed for invoice ${summary.stripe_invoice_id}: ${err.message}`);
        }
      } else {
        await this.invoiceUser(summary, summary.billing_month);
      }
    }
  }

  // ─── Process outstanding fees on subscription cancellation ─────────

  async processCancellationFees(userId: string): Promise<void> {
    const billingMonth = this.currentBillingMonth();
    const summary = await this.prisma.monthly_fee_summaries.findUnique({
      where: { user_id_billing_month: { user_id: userId, billing_month: billingMonth } },
      include: { user: { select: { user_id: true, stripe_customer_id: true, email: true } } },
    });

    if (!summary || summary.status !== 'accumulating' || Number(summary.total_fees_usd) < MIN_INVOICE_AMOUNT) {
      return;
    }

    this.logger.log(`Processing cancellation fees for user ${userId}: $${summary.total_fees_usd}`);
    await this.invoiceUser(summary, billingMonth);
  }

  // ─── API: Current month fees for a user ────────────────────────────

  async getUserMonthlyFees(userId: string, month?: string) {
    const billingMonth = month || this.currentBillingMonth();

    const summary = await this.prisma.monthly_fee_summaries.findUnique({
      where: { user_id_billing_month: { user_id: userId, billing_month: billingMonth } },
    });

    const recentFees = await this.prisma.trade_fees.findMany({
      where: { user_id: userId, billing_month: billingMonth },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    return {
      billing_month: billingMonth,
      total_trades: summary?.total_trades ?? 0,
      total_trade_volume_usd: Number(summary?.total_trade_volume_usd ?? 0),
      total_fees_usd: Number(summary?.total_fees_usd ?? 0),
      status: summary?.status ?? 'accumulating',
      recent_fees: recentFees.map((f) => ({
        fee_id: f.fee_id,
        asset_symbol: f.asset_symbol,
        side: f.trade_side,
        trade_value_usd: Number(f.trade_value_usd),
        fee_amount_usd: Number(f.fee_amount_usd),
        created_at: f.created_at,
      })),
    };
  }

  // ─── API: Monthly fee history ──────────────────────────────────────

  async getUserFeeHistory(userId: string, limit = 6) {
    const summaries = await this.prisma.monthly_fee_summaries.findMany({
      where: { user_id: userId },
      orderBy: { billing_month: 'desc' },
      take: limit,
    });

    return {
      months: summaries.map((s) => ({
        billing_month: s.billing_month,
        total_trades: s.total_trades,
        total_trade_volume_usd: Number(s.total_trade_volume_usd),
        total_fees_usd: Number(s.total_fees_usd),
        status: s.status.toUpperCase(),
        paid_at: s.paid_at,
      })),
    };
  }

  // ─── API: Fee preview calculator ───────────────────────────────────

  calculateFeePreview(tradeValueUsd: number) {
    return {
      trade_value_usd: tradeValueUsd,
      fee_percent: FEE_PERCENT * 100,
      fee_amount_usd: tradeValueUsd * FEE_PERCENT,
    };
  }
}
