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

  /**
   * Source of the order. Used to determine auto-OCO behavior and to meter
   * FREE-tier signal-trade quota (only 'top_trade' BUYs decrement quota).
   * Strict allowlist to prevent unknown values from bypassing the meter.
   */
  @IsOptional()
  @IsIn(['top_trade', 'top_trades_leaderboard_sell', 'dashboard_sell_button'])
  source?: 'top_trade' | 'top_trades_leaderboard_sell' | 'dashboard_sell_button';

  /**
   * When true and side=SELL, the backend performs a full position-close:
   *   1. Cancel any open TP/SL (OCO) orders on the symbol
   *   2. Override the supplied quantity with the live free balance, so any
   *      dust accrued between UI poll and click gets liquidated too
   *   3. Convert residual dust to USDT via Binance Convert (best-effort, Binance only)
   * Sent by the dashboard holdings + top-trades leaderboard "Sell" button
   * when the user is closing the *entire* position (Max). Ignored for BUY.
   */
  @IsOptional()
  @IsBoolean()
  closePosition?: boolean;

  /**
   * When true and side=SELL, the backend cancels any open TP/SL (OCO) orders
   * on the symbol before placing the sell — but does NOT override the
   * user-supplied quantity. Used for partial sells from dashboard /
   * open-positions where the user wants to exit part of the position; the
   * remaining shares are left without TP/SL (safer than letting an old TP/SL
   * trigger against a now-smaller holding). For full-position closes, prefer
   * `closePosition: true` (which already cancels TP/SL).
   */
  @IsOptional()
  @IsBoolean()
  cancelOpenOrders?: boolean;
}

