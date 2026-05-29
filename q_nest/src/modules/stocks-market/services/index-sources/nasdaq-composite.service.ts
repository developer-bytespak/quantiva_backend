import axios from 'axios';
import { IndexConstituent, IndexSourceResult, IndexSourceService } from './types';

const NASDAQ_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt';

export class NasdaqCompositeService implements IndexSourceService {
  readonly indexCode = 'NASDAQ_COMPOSITE';
  readonly displayName = 'Nasdaq Composite';

  async fetchConstituents(): Promise<IndexSourceResult> {
    const response = await axios.get<string>(NASDAQ_URL, {
      headers: {
        'User-Agent': 'QuantivaHQ/1.0 (https://quantivahq.com; contact@quantivahq.com)',
      },
      timeout: 30_000,
      responseType: 'text',
    });

    const lines = response.data.split(/\r?\n/);
    const symbols: IndexConstituent[] = [];
    const validSymbol = /^[A-Z][A-Z0-9]*$/;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('File Creation Time')) continue;

      const parts = line.split('|');
      if (parts.length < 7) continue;

      const symbol = parts[0].trim();
      const name = parts[1]?.trim();
      const testIssue = parts[3]?.trim();
      const financialStatus = parts[4]?.trim();
      const etf = parts[6]?.trim();

      if (testIssue === 'Y') continue;
      if (etf === 'Y') continue;
      if (financialStatus === 'D') continue;
      if (!validSymbol.test(symbol)) continue;

      symbols.push({ symbol, name: name || undefined });
    }

    if (symbols.length < 1500) {
      throw new Error(
        `Nasdaq Composite: expected 3000+ symbols, got ${symbols.length}. File format may have changed.`,
      );
    }

    return {
      symbols,
      sourceUrl: NASDAQ_URL,
      fetchedAt: new Date(),
    };
  }
}
