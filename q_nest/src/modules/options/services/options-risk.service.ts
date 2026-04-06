import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

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

@Injectable()
export class OptionsRiskService {
  private readonly logger = new Logger(OptionsRiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate Greeks across all open positions for a user.
   * Returns portfolio-level risk metrics.
   */
  async getPortfolioGreeks(userId: string): Promise<PortfolioGreeks> {
    const positions = await this.prisma.options_positions.findMany({
      where: { user_id: userId, is_open: true },
      select: {
        underlying: true,
        quantity: true,
        delta: true,
        gamma: true,
        theta: true,
        vega: true,
        unrealized_pnl: true,
      },
    });

    // Also fetch max_loss from related orders
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

      result.totalDelta += delta * qty;
      result.totalGamma += gamma * qty;
      result.totalTheta += theta * qty;
      result.totalVega += vega * qty;
      result.totalUnrealizedPnl += Number(pos.unrealized_pnl) || 0;

      const underlying = pos.underlying;
      if (!result.exposureByUnderlying[underlying]) {
        result.exposureByUnderlying[underlying] = { delta: 0, positions: 0 };
      }
      result.exposureByUnderlying[underlying].delta += delta * qty;
      result.exposureByUnderlying[underlying].positions += 1;
    }

    for (const order of orders) {
      result.totalMaxLoss += Number(order.max_loss) || 0;
    }

    // Round to 6 decimal places for cleanliness
    result.totalDelta = +result.totalDelta.toFixed(6);
    result.totalGamma = +result.totalGamma.toFixed(6);
    result.totalTheta = +result.totalTheta.toFixed(6);
    result.totalVega = +result.totalVega.toFixed(6);
    result.totalUnrealizedPnl = +result.totalUnrealizedPnl.toFixed(2);
    result.totalMaxLoss = +result.totalMaxLoss.toFixed(2);

    return result;
  }
}
