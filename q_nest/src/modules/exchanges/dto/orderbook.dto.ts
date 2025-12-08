export class OrderBookDto {
  bids: Array<{
    price: number;
    quantity: number;
    total?: number;
  }>;
  asks: Array<{
    price: number;
    quantity: number;
    total?: number;
  }>;
  lastUpdateId: number;
  spread: number;
  spreadPercent: number;
}

export class RecentTradeDto {
  id: string;
  price: number;
  quantity: number;
  time: number;
  isBuyerMaker: boolean;
}

