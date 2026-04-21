import { IsString, IsNotEmpty, IsIn, IsNumber, IsPositive, IsOptional, Min, Max, IsBoolean } from 'class-validator';

export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type: 'MARKET' | 'LIMIT';

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

  /** Stop-loss as a decimal fraction, e.g. 0.05 = 5% below entry. Defaults to 0.05. */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(0.5)
  stopLoss?: number;

  /** Take-profit as a decimal fraction, e.g. 0.10 = 10% above entry. Defaults to 0.10. */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(5)
  takeProfit?: number;

  /** When true, allow backend to auto-place OCO (take-profit + stop-loss) after a filled BUY. */
  @IsOptional()
  @IsBoolean()
  autoOco?: boolean;

  /** Source of order: 'top_trade', 'manual', etc. Used to determine auto-OCO behavior. */
  @IsOptional()
  @IsString()
  source?: string;

  /**
   * When true and side=SELL, the backend performs a full position-close:
   *   1. Cancel any open TP/SL (OCO) orders on the symbol
   *   2. Place the market sell (freed balance, no "Insufficient balance")
   *   3. Convert residual dust to USDT via Binance Convert (best-effort, Binance only)
   * Sent by the dashboard holdings + top-trades leaderboard "Sell" button.
   * Ignored for BUY orders.
   */
  @IsOptional()
  @IsBoolean()
  closePosition?: boolean;
}

