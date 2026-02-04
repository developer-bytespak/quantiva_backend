import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { ExchangesService } from '../../exchanges/exchanges.service';

/**
 * Custom Strategy Cronjob Service
 * 
 * NOTE: Custom strategy signal generation is now handled by PreBuiltSignalsCronjobService.
 * This service is kept for backward compatibility with imports/DI but the actual
 * signal generation logic has been moved to the pre-built cronjob to:
 * 
 * 1. Avoid duplicate processing
 * 2. Use the same cached market data (no separate API calls)
 * 3. Run sentiment analysis once per asset
 * 4. Eliminate timeout issues
 * 
 * Custom strategies are processed automatically after pre-built strategies
 * in the main cronjob (every 10 minutes at :00, :10, :20, etc.)
 */
@Injectable()
export class CustomStrategyCronjobService {
  private readonly logger = new Logger(CustomStrategyCronjobService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
  ) {}

  /**
   * Legacy method for manual signal generation
   * Now just returns a message - actual generation happens in PreBuiltSignalsCronjobService
   */
  async generateSignalsForStrategy(strategyId: string): Promise<{
    success: boolean;
    message: string;
    signalsGenerated: number;
    errors: string[];
  }> {
    this.logger.log(`Signal generation requested for strategy ${strategyId}`);
    
    // Signal generation is now handled by the pre-built cronjob
    // Just return a success message - the controller handles the response
    return {
      success: true,
      message: 'Signal generation is handled automatically by the scheduled cronjob (every 10 minutes)',
      signalsGenerated: 0,
      errors: [],
    };
  }

  /**
   * Get all active user custom strategies
   * This method is used by PreBuiltSignalsCronjobService
   */
  async getActiveCustomStrategies(): Promise<any[]> {
    return this.prisma.strategies.findMany({
      where: {
        type: 'user',
        is_active: true,
        user_id: { not: null },
        // Note: target_assets can be null - we'll use all trending assets in that case
      },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
          },
        },
      },
    });
  }
}
