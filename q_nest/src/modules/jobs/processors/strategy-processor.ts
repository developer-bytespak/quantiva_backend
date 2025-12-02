import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { SignalsService } from '../../signals/signals.service';

interface StrategyJobData {
  strategy_id: string;
  asset_id: string;
  user_id?: string;
}

@Processor('strategy-execution')
@Injectable()
export class StrategyProcessor extends WorkerHost {
  private readonly logger = new Logger(StrategyProcessor.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private signalsService: SignalsService,
  ) {
    super();
  }

  async process(job: Job<StrategyJobData>): Promise<any> {
    const { strategy_id, asset_id, user_id } = job.data;
    
    this.logger.log(`Processing strategy execution job for strategy ${strategy_id}, asset ${asset_id}`);

    try {
      // Update job status to running
      await this.prisma.strategy_execution_jobs.updateMany({
        where: { job_id: job.id },
        data: { 
          status: 'running',
          started_at: new Date(),
        },
      });

      // Fetch strategy from database
      const strategy = await this.prisma.strategies.findUnique({
        where: { strategy_id },
        include: { user: true },
      });

      if (!strategy) {
        throw new Error(`Strategy ${strategy_id} not found`);
      }

      // Fetch asset information
      const asset = await this.prisma.assets.findUnique({
        where: { asset_id },
      });

      if (!asset) {
        throw new Error(`Asset ${asset_id} not found`);
      }

      // TODO: Fetch market data (OHLCV, order book) from exchange APIs
      // For now, using placeholder data structure
      const marketData = {
        price: 0, // TODO: Fetch from exchange
        volume_24h: 0, // TODO: Fetch from exchange
        avg_volume_30d: 0, // TODO: Calculate from historical data
        asset_type: asset.asset_type || 'crypto',
      };

      const ohlcvData = null; // TODO: Fetch OHLCV data from exchange
      const orderBook = null; // TODO: Fetch order book from exchange

      // Prepare strategy data for Python API
      const strategyData = {
        entry_rules: strategy.entry_rules,
        exit_rules: strategy.exit_rules,
        indicators: strategy.indicators,
        timeframe: strategy.timeframe,
        stop_loss_type: strategy.stop_loss_type,
        stop_loss_value: strategy.stop_loss_value,
        take_profit_type: strategy.take_profit_type,
        take_profit_value: strategy.take_profit_value,
        risk_level: strategy.risk_level,
        user_id: user_id || strategy.user_id,
      };

      // Generate signal via Python API
      const signal = await this.signalsService.generateSignalFromPython(
        strategy_id,
        asset_id,
        strategyData,
        marketData,
        ohlcvData,
        orderBook,
        undefined, // portfolio_value - TODO: Fetch from user portfolio
      );

      // Update job status to completed
      await this.prisma.strategy_execution_jobs.updateMany({
        where: { job_id: job.id },
        data: { 
          status: 'completed',
          completed_at: new Date(),
        },
      });

      this.logger.log(`Strategy execution completed for strategy ${strategy_id}, signal: ${signal.action}`);

      return {
        success: true,
        signal_id: signal.signal_id,
        action: signal.action,
      };
    } catch (error: any) {
      this.logger.error(`Strategy execution failed: ${error.message}`, error.stack);

      // Update job status to failed
      await this.prisma.strategy_execution_jobs.updateMany({
        where: { job_id: job.id },
        data: { 
          status: 'failed',
          completed_at: new Date(),
          error_message: error.message,
        },
      });

      throw error;
    }
  }
}

