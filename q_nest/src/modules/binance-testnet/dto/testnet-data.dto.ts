export class AssetTestnetBalanceDto {
  asset: string;
  free: number;
  locked: number;
}

export class AccountTestnetBalanceDto {
  balances: AssetTestnetBalanceDto[];
  totalBalanceUSD: number;
}

export class TestnetOrderDto {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price: number;
  status: string;
  timestamp: number;
  executedQuantity: number;
  cumulativeQuoteAssetTransacted: number;
}

export class TestnetPositionDto {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export class TestnetPortfolioDto {
  totalBalance: number;
  totalBalanceUSD: number;
  totalPnL: number;
  totalPnLPercent: number;
  positions: TestnetPositionDto[];
  dailyPnL: number;
  dailyPnLPercent: number;
}

export class TestnetTickerPriceDto {
  symbol: string;
  price: number;
  timestamp: number;
}

export class TestnetOrderBookDto {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: number;
}

export class TestnetRecentTradeDto {
  id: number;
  symbol: string;
  price: number;
  qty: number;
  time: number;
  isBuyerMaker: boolean;
}
