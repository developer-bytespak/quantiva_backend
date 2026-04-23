import { getDividendYield, getRiskFreeRate } from './market-params';

describe('getDividendYield', () => {
  test('returns known yields for default underlyings', () => {
    expect(getDividendYield('SPY')).toBeCloseTo(0.013, 3);
    expect(getDividendYield('QQQ')).toBeCloseTo(0.005, 3);
    expect(getDividendYield('MSFT')).toBeCloseTo(0.007, 3);
  });

  test('non-payers return 0', () => {
    expect(getDividendYield('TSLA')).toBe(0);
    expect(getDividendYield('AMZN')).toBe(0);
    expect(getDividendYield('GOOG')).toBe(0);
  });

  test('unknown ticker defaults to 0 (no throw)', () => {
    expect(getDividendYield('NOPE')).toBe(0);
    expect(getDividendYield('RANDOMCO')).toBe(0);
  });

  test('case-insensitive', () => {
    expect(getDividendYield('spy')).toBe(getDividendYield('SPY'));
    expect(getDividendYield('Aapl')).toBe(getDividendYield('AAPL'));
  });
});

describe('getRiskFreeRate', () => {
  const originalEnv = process.env.OPTIONS_RISK_FREE_RATE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPTIONS_RISK_FREE_RATE;
    else process.env.OPTIONS_RISK_FREE_RATE = originalEnv;
  });

  test('defaults to 0.045 when env is unset', () => {
    delete process.env.OPTIONS_RISK_FREE_RATE;
    expect(getRiskFreeRate()).toBe(0.045);
  });

  test('honors a valid env override', () => {
    process.env.OPTIONS_RISK_FREE_RATE = '0.053';
    expect(getRiskFreeRate()).toBe(0.053);
  });

  test('ignores obviously-bad env values (returns default)', () => {
    for (const bad of ['banana', '-0.5', '0.99', '', 'NaN']) {
      process.env.OPTIONS_RISK_FREE_RATE = bad;
      expect(getRiskFreeRate()).toBe(0.045);
    }
  });

  test('accepts 0 as valid', () => {
    process.env.OPTIONS_RISK_FREE_RATE = '0';
    expect(getRiskFreeRate()).toBe(0);
  });
});
