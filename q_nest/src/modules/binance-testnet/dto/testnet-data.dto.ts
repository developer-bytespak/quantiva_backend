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

/**
 * OCO (One-Cancels-Other) Order DTO
 * Represents a bracket order with both take-profit and stop-loss orders
 */
export class OcoOrderDto {
  orderListId: number;
  contingencyType: string;
  listStatusType: string;
  listOrderStatus: string;
  listClientOrderId: string;
  transactionTime: number;
  symbol: string;
  orders: OcoOrderItemDto[];
  orderReports: OcoOrderReportDto[];
}

export class OcoOrderItemDto {
  orderId: number;
  symbol: string;
  clientOrderId: string;
}

export class OcoOrderReportDto {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: string;
  origQty: string;
  status: string;
  stopPrice?: string;
}

/**
 * Request DTO for placing an OCO order
 */
export class PlaceOcoOrderDto {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  stopLimitPrice?: number;
}
