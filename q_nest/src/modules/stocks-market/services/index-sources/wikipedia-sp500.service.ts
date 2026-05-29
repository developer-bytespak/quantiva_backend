import axios from 'axios';
import * as cheerio from 'cheerio';
import { IndexConstituent, IndexSourceResult, IndexSourceService } from './types';

const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

export class WikipediaSp500Service implements IndexSourceService {
  readonly indexCode = 'SP500';
  readonly displayName = 'S&P 500';

  async fetchConstituents(): Promise<IndexSourceResult> {
    const response = await axios.get<string>(WIKIPEDIA_URL, {
      headers: {
        'User-Agent': 'QuantivaHQ/1.0 (https://quantivahq.com; contact@quantivahq.com)',
      },
      timeout: 30_000,
    });

    const $ = cheerio.load(response.data);
    const symbols: IndexConstituent[] = [];

    const table = $('table.wikitable').first();
    if (table.length === 0) {
      throw new Error('Wikipedia S&P 500 page: no wikitable found');
    }

    table.find('tbody > tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const symbol = $(cells[0]).text().trim();
      const name = $(cells[1]).text().trim();

      if (symbol && /^[A-Z][A-Z0-9.-]*$/.test(symbol)) {
        symbols.push({ symbol, name: name || undefined });
      }
    });

    if (symbols.length < 400) {
      throw new Error(
        `Wikipedia S&P 500: expected ~500 symbols, got ${symbols.length}. Table structure may have changed.`,
      );
    }

    return {
      symbols,
      sourceUrl: WIKIPEDIA_URL,
      fetchedAt: new Date(),
    };
  }
}
