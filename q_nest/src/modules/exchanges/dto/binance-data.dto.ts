export class AssetBalanceDto {
  symbol: string;
  free: string;
  locked: string;
  total: string;
}

export class AccountBalanceDto {
  assets: AssetBalanceDto[];
  totalValueUSD: number;
}

export class PositionDto {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  pnlPercent: number;
}

export class OrderDto {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: number;
  price: number;
  status: string;
  time: number;
}

export class AssetSummaryDto {
  symbol: string;
  quantity: number;
  value: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
}

export class PortfolioDto {
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  pnlPercent: number;
  assets: AssetSummaryDto[];
}

export class TickerPriceDto {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
}

export class CandlestickDto {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

