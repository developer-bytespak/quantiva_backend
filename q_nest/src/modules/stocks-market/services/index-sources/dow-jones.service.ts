import { IndexSourceResult, IndexSourceService } from './types';

const DOW_30_SYMBOLS: string[] = [
  'AAPL', 'AMGN', 'AMZN', 'AXP', 'BA',
  'CAT', 'CRM', 'CSCO', 'CVX', 'DIS',
  'GS', 'HD', 'HON', 'IBM', 'JNJ',
  'JPM', 'KO', 'MCD', 'MMM', 'MRK',
  'MSFT', 'NKE', 'NVDA', 'PG', 'SHW',
  'TRV', 'UNH', 'V', 'VZ', 'WMT',
];

export class DowJonesService implements IndexSourceService {
  readonly indexCode = 'DOW';
  readonly displayName = 'Dow Jones Industrial Average';

  async fetchConstituents(): Promise<IndexSourceResult> {
    return {
      symbols: DOW_30_SYMBOLS.map((symbol) => ({ symbol })),
      sourceUrl: 'hardcoded',
      fetchedAt: new Date(),
    };
  }
}
