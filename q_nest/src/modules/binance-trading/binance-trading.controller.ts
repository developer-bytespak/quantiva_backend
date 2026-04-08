import {
  Controller,
  UseGuards,
} from '@nestjs/common';
import { BinanceTradingService } from './binance-trading.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Legacy Binance Trading Controller
 * All endpoints have been migrated to the unified /exchanges/connections/:id/ routes.
 */
@Controller('binance-trading')
@UseGuards(JwtAuthGuard)
export class BinanceTradingController {
  constructor(private readonly binanceTradingService: BinanceTradingService) {}
}
