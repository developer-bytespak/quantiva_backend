export interface IBinanceAccount {
  accountType: string;
  permissions: string[];
  balances: Array<{
    asset: string;
    free: string;
    locked: string;
  }>;
}

export interface IBinancePosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  pnlPercent: number;
}

export interface IBinanceOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: number;
  price: number;
  status: string;
  time: number;
}

export interface IBinancePortfolio {
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  pnlPercent: number;
  assets: Array<{
    symbol: string;
    quantity: number;
    value: number;
    cost: number;
    pnl: number;
    pnlPercent: number;
  }>;
}

export interface IBinanceTickerPrice {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
}

export interface IBinanceVerificationResult {
  valid: boolean;
  permissions: string[];
  accountType: string;
}

