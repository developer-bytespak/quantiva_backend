/**
 * Market data types for stocks dashboard
 */

export interface MarketStock {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  marketCap: number | null;
  volume24h: number;
  /** Annual dividend yield as a percent (2.4 = 2.4%). 0 = confirmed non-payer, null/undefined = unknown. */
  dividendYield?: number | null;
  /** Monthly | Quarterly | Semi-Annual | Annual | Irregular */
  dividendFrequency?: string | null;
  /** Most recent ex-dividend date, YYYY-MM-DD */
  exDividendDate?: string | null;
  dataSource?: string;
  timestamp?: Date;
}

export interface MarketDataResponse {
  items: MarketStock[];
  timestamp: string;
  warnings?: string[];
}

export interface FmpCompanyProfile {
  symbol: string;
  companyName: string;
  price: number;
  changes: number;
  changesPercentage: number;
  marketCap: number;
  volume: number;
  sector: string;
  industry: string;
}

export interface CachedMarketData {
  data: MarketStock[];
  timestamp: Date;
  ttl: number;
}
