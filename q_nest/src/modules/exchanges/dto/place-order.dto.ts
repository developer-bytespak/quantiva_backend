export class PlaceOrderDto {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number; // Required for LIMIT orders, optional for MARKET orders
}

