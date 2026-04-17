/**
 * Curated list of 100 US stocks used by the bulk general-stock-news cron.
 *
 * Passed as a comma-separated `tickers` parameter to StockNewsAPI (primary)
 * which returns articles related to any of these symbols. When StockNewsAPI
 * is unavailable, Finnhub's general-news endpoint is used instead — that
 * endpoint ignores the ticker filter and returns latest US market news
 * across all tickers, so this list does not narrow the Finnhub feed.
 *
 * Curated from: S&P 100 mega-caps + popular growth/ETF picks + retail
 * favorites. Grouped by sector for readability.
 */
export const STOCK_TICKERS_100: string[] = [
  // Mega-cap tech (10)
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL', 'CRM',
  // Semis / hardware (10)
  'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'ADI', 'KLAC', 'MRVL',
  // Consumer (10)
  'WMT', 'COST', 'HD', 'LOW', 'NKE', 'MCD', 'SBUX', 'TGT', 'PG', 'KO',
  // Communications / media (8)
  'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'ROKU', 'SPOT',
  // Finance (12)
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'V', 'MA', 'PYPL', 'AXP', 'SQ', 'COIN',
  // Healthcare (10)
  'JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'DHR', 'CVS',
  // Industrial / auto (8)
  'BA', 'CAT', 'GE', 'HON', 'DE', 'LMT', 'F', 'GM',
  // Energy (6)
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'EOG',
  // Real estate / utilities (6)
  'PLD', 'AMT', 'CCI', 'NEE', 'DUK', 'SO',
  // Growth / popular (10)
  'SHOP', 'UBER', 'ABNB', 'PLTR', 'SNOW', 'CRWD', 'ZS', 'DDOG', 'MDB', 'NOW',
  // ETFs for market indicators (5)
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI',
  // Meme / retail favorites (5)
  'GME', 'AMC', 'RBLX', 'HOOD', 'SOFI',
];
