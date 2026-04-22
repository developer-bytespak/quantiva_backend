import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ALPACA_CONTRACT_MULTIPLIER } from './alpaca/alpaca-contract-specs';

export interface PortfolioGreeks {
  totalDelta: number;
  totalGamma: number;
  totalTheta: number;
  totalVega: number;
  totalUnrealizedPnl: number;
  totalMaxLoss: number;
  positionCount: number;
  exposureByUnderlying: Record<string, { delta: number; positions: number }>;
}

/**
 * Per-venue contract multiplier used when translating per-contract greeks
 * into portfolio-dollar exposure.
 * - Binance crypto options: 0.01 of the underlying per contract.
 * - Alpaca US equity options: 100 shares per contract.
 */
const VENUE_MULTIPLIER: Record<string, number> = {
  BINANCE: 0.01,
  ALPACA: ALPACA_CONTRACT_MULTIPLIER,
};

function multiplierForVenue(venue: string | null | undefined): number {
  if (!venue) return VENUE_MULTIPLIER.BINANCE;
  return VENUE_MULTIPLIER[venue] ?? VENUE_MULTIPLIER.BINANCE;
}

@Injectable()
export class OptionsRiskService {
  private readonly logger = new Logger(OptionsRiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate Greeks across all open positions for a user.
   * Multiplies raw per-contract greeks by the venue's contract multiplier so
   * totals are expressed in underlying-unit or share-unit terms (not
   * per-contract), which is how traders actually size exposure.
   */
  async getPortfolioGreeks(userId: string): Promise<PortfolioGreeks> {
    const positions = await this.prisma.options_positions.findMany({
      where: { user_id: userId, is_open: true },
      select: {
        underlying: true,
        venue: true,
        quantity: true,
        delta: true,
        gamma: true,
        theta: true,
        vega: true,
        unrealized_pnl: true,
      },
    });

    const orders = await this.prisma.options_orders.findMany({
      where: {
        user_id: userId,
        status: { in: ['pending', 'filled', 'partially_filled'] },
      },
      select: { max_loss: true },
    });

    const result: PortfolioGreeks = {
      totalDelta: 0,
      totalGamma: 0,
      totalTheta: 0,
      totalVega: 0,
      totalUnrealizedPnl: 0,
      totalMaxLoss: 0,
      positionCount: positions.length,
      exposureByUnderlying: {},
    };

    for (const pos of positions) {
      const qty = Number(pos.quantity) || 0;
      const delta = Number(pos.delta) || 0;
      const gamma = Number(pos.gamma) || 0;
      const theta = Number(pos.theta) || 0;
      const vega = Number(pos.vega) || 0;
      const m = multiplierForVenue(pos.venue as unknown as string);

      const deltaExposure = delta * qty * m;
      result.totalDelta += deltaExposure;
      result.totalGamma += gamma * qty * m;
      result.totalTheta += theta * qty * m;
      result.totalVega += vega * qty * m;
      result.totalUnrealizedPnl += Number(pos.unrealized_pnl) || 0;

      const underlying = pos.underlying;
      if (!result.exposureByUnderlying[underlying]) {
        result.exposureByUnderlying[underlying] = { delta: 0, positions: 0 };
      }
      result.exposureByUnderlying[underlying].delta += deltaExposure;
      result.exposureByUnderlying[underlying].positions += 1;
    }

    for (const order of orders) {
      result.totalMaxLoss += Number(order.max_loss) || 0;
    }

    result.totalDelta = +result.totalDelta.toFixed(6);
    result.totalGamma = +result.totalGamma.toFixed(6);
    result.totalTheta = +result.totalTheta.toFixed(6);
    result.totalVega = +result.totalVega.toFixed(6);
    result.totalUnrealizedPnl = +result.totalUnrealizedPnl.toFixed(2);
    result.totalMaxLoss = +result.totalMaxLoss.toFixed(2);

    return result;
  }
}
