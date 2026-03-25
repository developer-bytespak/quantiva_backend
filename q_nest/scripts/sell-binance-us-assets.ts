import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

type SymbolRules = {
  symbol: string;
  stepSize: number;
  minQty: number;
  minNotional: number;
};

class BinanceUSLiquidator {
  private readonly baseUrl = 'https://api.binance.us';
  private readonly client: AxiosInstance;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });
  }

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  private async serverTime(): Promise<number> {
    const res = await this.client.get('/api/v3/time');
    return res.data.serverTime;
  }

  private async signedGet(path: string, params: Record<string, string> = {}) {
    const timestamp = await this.serverTime();
    const query = new URLSearchParams({
      ...params,
      timestamp: timestamp.toString(),
      recvWindow: '60000',
    }).toString();
    const signature = this.sign(query);
    const res = await this.client.get(`${path}?${query}&signature=${signature}`);
    return res.data;
  }

  private async signedPost(path: string, params: Record<string, string>) {
    const timestamp = await this.serverTime();
    const query = new URLSearchParams({
      ...params,
      timestamp: timestamp.toString(),
      recvWindow: '60000',
    }).toString();
    const signature = this.sign(query);
    const res = await this.client.post(`${path}?${query}&signature=${signature}`);
    return res.data;
  }

  async getFreeBalance(asset: string): Promise<number> {
    const account = await this.signedGet('/api/v3/account');
    const balance = (account.balances || []).find((b: any) => b.asset === asset);
    return Number(balance?.free || 0);
  }

  async getPrice(symbol: string): Promise<number> {
    const res = await this.client.get('/api/v3/ticker/price', { params: { symbol } });
    return Number(res.data.price || 0);
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const res = await this.client.get('/api/v3/exchangeInfo', { params: { symbol } });
    const s = res.data?.symbols?.[0];
    if (!s) {
      throw new Error(`Symbol not found on Binance.US: ${symbol}`);
    }

    const lotSize = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const minNotionalFilter = s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');

    return {
      symbol,
      stepSize: Number(lotSize?.stepSize || 0.000001),
      minQty: Number(lotSize?.minQty || 0),
      minNotional: Number(minNotionalFilter?.minNotional || 0),
    };
  }

  normalizeQty(qty: number, stepSize: number): number {
    if (qty <= 0 || stepSize <= 0) return 0;
    const precision = this.stepSizePrecision(stepSize);
    const steps = Math.floor(qty / stepSize);
    return Number((steps * stepSize).toFixed(precision));
  }

  private stepSizePrecision(stepSize: number): number {
    const s = stepSize.toString();
    if (!s.includes('.')) return 0;
    return s.split('.')[1].replace(/0+$/, '').length;
  }

  async placeMarketSell(symbol: string, quantity: number) {
    return this.signedPost('/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity.toString(),
    });
  }
}

async function run() {
  const apiKey = process.env.BINANCE_US_API_KEY || '';
  const apiSecret = process.env.BINANCE_US_API_SECRET || '';
  const execute = process.argv.includes('--execute');

  if (!apiKey || !apiSecret) {
    throw new Error('Missing BINANCE_US_API_KEY or BINANCE_US_API_SECRET environment variables');
  }

  const assets = ['DOGE', 'SOL', 'UNI'];
  const quote = 'USD';
  const liquidator = new BinanceUSLiquidator(apiKey, apiSecret);

  console.log('========================================');
  console.log('Binance.US Liquidation Script');
  console.log(`Mode: ${execute ? 'LIVE EXECUTION' : 'DRY RUN (no order placement)'}`);
  console.log('Assets:', assets.join(', '));
  console.log('========================================\n');

  const results: Array<{ asset: string; symbol: string; status: string; detail: string }> = [];

  for (const asset of assets) {
    const symbol = `${asset}${quote}`;

    try {
      const free = await liquidator.getFreeBalance(asset);
      const rules = await liquidator.getSymbolRules(symbol);
      const price = await liquidator.getPrice(symbol);
      const quantity = liquidator.normalizeQty(free, rules.stepSize);
      const notional = quantity * price;

      if (quantity <= 0) {
        results.push({
          asset,
          symbol,
          status: 'SKIPPED',
          detail: `Quantity is 0 after normalization (free=${free})`,
        });
        continue;
      }

      if (quantity < rules.minQty) {
        results.push({
          asset,
          symbol,
          status: 'SKIPPED',
          detail: `Quantity ${quantity} < minQty ${rules.minQty}`,
        });
        continue;
      }

      if (rules.minNotional > 0 && notional < rules.minNotional) {
        results.push({
          asset,
          symbol,
          status: 'SKIPPED',
          detail: `Notional ${notional.toFixed(8)} < minNotional ${rules.minNotional}`,
        });
        continue;
      }

      if (!execute) {
        results.push({
          asset,
          symbol,
          status: 'DRY_RUN_OK',
          detail: `Would SELL ${quantity} ${asset} @ ~${price} ${quote}`,
        });
        continue;
      }

      const order = await liquidator.placeMarketSell(symbol, quantity);
      results.push({
        asset,
        symbol,
        status: 'SOLD',
        detail: `orderId=${order.orderId}, executedQty=${order.executedQty || quantity}`,
      });
    } catch (error: any) {
      results.push({
        asset,
        symbol,
        status: 'FAILED',
        detail: error?.response?.data?.msg || error?.message || 'Unknown error',
      });
    }
  }

  console.log('Results:\n');
  for (const r of results) {
    console.log(`${r.asset} (${r.symbol}) -> ${r.status}: ${r.detail}`);
  }

  const soldCount = results.filter((r) => r.status === 'SOLD').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;
  const skippedCount = results.filter((r) => r.status.startsWith('SKIPPED')).length;
  const dryCount = results.filter((r) => r.status === 'DRY_RUN_OK').length;

  console.log('\n========================================');
  console.log(`Summary: sold=${soldCount}, dry_run_ok=${dryCount}, skipped=${skippedCount}, failed=${failedCount}`);
  console.log('========================================');
}

run().catch((err) => {
  console.error('Fatal error:', err?.response?.data || err?.message || err);
  process.exit(1);
});
