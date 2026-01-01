/**
 * Top 50 S&P 500 stocks by market cap
 * Subset for faster development and testing
 */

import { StockSymbol } from './sp500-symbols';

export const SP500_TOP50: StockSymbol[] = [
  // Top 10 - Mega Cap Tech
  { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', sector: 'Technology' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', sector: 'Consumer Discretionary' },
  { symbol: 'META', name: 'Meta Platforms Inc.', sector: 'Technology' },
  { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Technology' },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc. Class B', sector: 'Financials' },
  { symbol: 'LLY', name: 'Eli Lilly and Company', sector: 'Healthcare' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Technology' },

  // 11-20 - Large Cap Mix
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financials' },
  { symbol: 'V', name: 'Visa Inc.', sector: 'Financials' },
  { symbol: 'UNH', name: 'UnitedHealth Group Incorporated', sector: 'Healthcare' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', sector: 'Energy' },
  { symbol: 'MA', name: 'Mastercard Incorporated', sector: 'Financials' },
  { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumer Staples' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
  { symbol: 'PG', name: 'The Procter & Gamble Company', sector: 'Consumer Staples' },
  { symbol: 'ORCL', name: 'Oracle Corporation', sector: 'Technology' },
  { symbol: 'HD', name: 'The Home Depot Inc.', sector: 'Consumer Discretionary' },

  // 21-30
  { symbol: 'COST', name: 'Costco Wholesale Corporation', sector: 'Consumer Staples' },
  { symbol: 'NFLX', name: 'Netflix Inc.', sector: 'Communication Services' },
  { symbol: 'ABBV', name: 'AbbVie Inc.', sector: 'Healthcare' },
  { symbol: 'CVX', name: 'Chevron Corporation', sector: 'Energy' },
  { symbol: 'BAC', name: 'Bank of America Corporation', sector: 'Financials' },
  { symbol: 'CRM', name: 'Salesforce Inc.', sector: 'Technology' },
  { symbol: 'MRK', name: 'Merck & Co. Inc.', sector: 'Healthcare' },
  { symbol: 'KO', name: 'The Coca-Cola Company', sector: 'Consumer Staples' },
  { symbol: 'CSCO', name: 'Cisco Systems Inc.', sector: 'Technology' },
  { symbol: 'PEP', name: 'PepsiCo Inc.', sector: 'Consumer Staples' },

  // 31-40
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc.', sector: 'Technology' },
  { symbol: 'TMO', name: 'Thermo Fisher Scientific Inc.', sector: 'Healthcare' },
  { symbol: 'LIN', name: 'Linde plc', sector: 'Materials' },
  { symbol: 'ADBE', name: 'Adobe Inc.', sector: 'Technology' },
  { symbol: 'ABT', name: 'Abbott Laboratories', sector: 'Healthcare' },
  { symbol: 'DIS', name: 'The Walt Disney Company', sector: 'Communication Services' },
  { symbol: 'WFC', name: 'Wells Fargo & Company', sector: 'Financials' },
  { symbol: 'INTC', name: 'Intel Corporation', sector: 'Technology' },
  { symbol: 'CMCSA', name: 'Comcast Corporation', sector: 'Communication Services' },
  { symbol: 'QCOM', name: 'Qualcomm Inc.', sector: 'Technology' },

  // 41-50
  { symbol: 'DHR', name: 'Danaher Corporation', sector: 'Healthcare' },
  { symbol: 'PM', name: 'Philip Morris International Inc.', sector: 'Consumer Staples' },
  { symbol: 'VZ', name: 'Verizon Communications Inc.', sector: 'Communication Services' },
  { symbol: 'TXN', name: 'Texas Instruments Inc.', sector: 'Technology' },
  { symbol: 'NEE', name: 'NextEra Energy Inc.', sector: 'Utilities' },
  { symbol: 'HON', name: 'Honeywell International Inc.', sector: 'Industrials' },
  { symbol: 'RTX', name: 'RTX Corporation', sector: 'Industrials' },
  { symbol: 'UPS', name: 'United Parcel Service Inc.', sector: 'Industrials' },
  { symbol: 'INTU', name: 'Intuit Inc.', sector: 'Technology' },
  { symbol: 'NKE', name: 'NIKE Inc.', sector: 'Consumer Discretionary' },
];

export default SP500_TOP50;
