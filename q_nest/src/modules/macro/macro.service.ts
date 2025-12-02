import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class MacroService {
  private readonly logger = new Logger(MacroService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Fetch all primary indicators from Python API and store in database.
   */
  async fetchAndStoreMacroData(): Promise<void> {
    try {
      // Call Python API to fetch FRED data
      const response = await this.pythonApi.axiosInstance.post('/api/v1/macro/fetch-all');
      const indicators = response.data;

      // Store each indicator
      for (const [key, data] of Object.entries(indicators)) {
        if (!data || typeof data !== 'object') continue;

        await this.storeIndicator(key, data);
      }

      this.logger.log('Macro data fetched and stored successfully');
    } catch (error: any) {
      this.logger.error(`Error fetching macro data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Store an indicator value in the database.
   */
  private async storeIndicator(
    indicatorKey: string,
    indicatorData: any,
  ): Promise<void> {
    try {
      // Map indicator keys to FRED series IDs
      const seriesIdMap: Record<string, string> = {
        cpi: 'CPIAUCSL',
        fedfunds: 'FEDFUNDS',
        nfp: 'PAYEMS',
        gdp: 'GDP',
      };

      const seriesId = seriesIdMap[indicatorKey];
      if (!seriesId) return;

      // Find or create indicator record
      let indicator = await this.prisma.macro_indicators.findFirst({
        where: { code: seriesId },
      });

      if (!indicator) {
        indicator = await this.prisma.macro_indicators.create({
          data: {
            code: seriesId,
            name: this.getIndicatorName(seriesId),
            category: this.getIndicatorCategory(seriesId),
            frequency: this.getIndicatorFrequency(seriesId),
            source: 'FRED',
          },
        });
      }

      // Store value if available
      if (indicatorData.value && indicatorData.date) {
        await this.prisma.macro_indicator_values.upsert({
          where: {
            indicator_id_data_date: {
              indicator_id: indicator.indicator_id,
              data_date: new Date(indicatorData.date),
            },
          },
          update: {
            value: indicatorData.value,
            updated_at: new Date(),
          },
          create: {
            indicator_id: indicator.indicator_id,
            data_date: new Date(indicatorData.date),
            value: indicatorData.value,
            updated_at: new Date(),
          },
        });
      }

      // Handle yield curve separately (it's calculated, not a direct series)
      if (indicatorKey === 'yield_curve' && indicatorData.spread !== undefined) {
        // Store yield curve spread as a calculated indicator
        // This would require a separate indicator record for yield curve
      }
    } catch (error: any) {
      this.logger.error(`Error storing indicator ${indicatorKey}: ${error.message}`);
    }
  }

  /**
   * Get latest macro indicator value.
   */
  async getLatestIndicator(seriesId: string): Promise<any> {
    const indicator = await this.prisma.macro_indicators.findFirst({
      where: { code: seriesId },
      include: {
        values: {
          orderBy: { data_date: 'desc' },
          take: 1,
        },
      },
    });

    if (!indicator || indicator.values.length === 0) {
      return null;
    }

    return {
      indicator_id: indicator.indicator_id,
      code: indicator.code,
      name: indicator.name,
      latest_value: indicator.values[0].value,
      latest_date: indicator.values[0].data_date,
    };
  }

  /**
   * Daily job to check and update daily indicators (FEDFUNDS, Yield Curve).
   * Runs at 9:00 AM EST.
   */
  @Cron('0 9 * * *') // 9:00 AM daily
  async updateDailyIndicators(): Promise<void> {
    this.logger.log('Running daily macro indicator update');
    try {
      await this.fetchAndStoreMacroData();
    } catch (error: any) {
      this.logger.error(`Daily macro update failed: ${error.message}`);
    }
  }

  /**
   * Weekly job to check and update quarterly indicators (GDP).
   * Runs Monday at 9:00 AM EST.
   */
  @Cron('0 9 * * 1') // Monday 9:00 AM
  async updateWeeklyIndicators(): Promise<void> {
    this.logger.log('Running weekly macro indicator update');
    try {
      await this.fetchAndStoreMacroData();
    } catch (error: any) {
      this.logger.error(`Weekly macro update failed: ${error.message}`);
    }
  }

  private getIndicatorName(seriesId: string): string {
    const names: Record<string, string> = {
      CPIAUCSL: 'Consumer Price Index',
      FEDFUNDS: 'Federal Funds Rate',
      PAYEMS: 'Non-Farm Payrolls',
      GDP: 'Gross Domestic Product',
      DGS10: '10-Year Treasury Rate',
      DGS2: '2-Year Treasury Rate',
    };
    return names[seriesId] || seriesId;
  }

  private getIndicatorCategory(seriesId: string): string {
    if (['CPIAUCSL', 'PAYEMS', 'GDP'].includes(seriesId)) {
      return 'Economic';
    } else if (['FEDFUNDS', 'DGS10', 'DGS2'].includes(seriesId)) {
      return 'Monetary';
    }
    return 'Other';
  }

  private getIndicatorFrequency(seriesId: string): string {
    if (['CPIAUCSL', 'PAYEMS'].includes(seriesId)) {
      return 'Monthly';
    } else if (seriesId === 'GDP') {
      return 'Quarterly';
    }
    return 'Daily';
  }
}

