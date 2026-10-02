import { ConfigService } from '@nestjs/config';
import { BinanceService } from './binance.service';
import {
  InvalidApiKeyException,
  BinanceRateLimitException,
} from '../exceptions/binance.exceptions';

// Covers the API-key restriction check added after a Binance user linked a
// read-only key: /api/v3/account verified fine, every order then failed
// with -2015. verifyApiKey must now refuse such keys up front when the
// connection is being linked for trading, and stay lenient otherwise.

const ACCOUNT = { accountType: 'SPOT', permissions: ['TRD_GRP_054'], balances: [] };
const OK_RESTRICTIONS = { ipRestrict: false, enableReading: true, enableSpotAndMarginTrading: true };

function makeService() {
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const service = new BinanceService(config);
  const signed = jest.spyOn(service as any, 'makeSignedRequest');
  return { service, signed };
}

function routeSigned(signed: jest.SpyInstance, restrictions: any) {
  signed.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/v3/account') return ACCOUNT;
    if (endpoint === '/sapi/v1/account/apiRestrictions') {
      if (restrictions instanceof Error) throw restrictions;
      return restrictions;
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
}

describe('BinanceService.verifyApiKey key restrictions', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not query restrictions when trading is not requested', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, { ...OK_RESTRICTIONS, enableSpotAndMarginTrading: false });

    const result = await service.verifyApiKey('k', 's');

    expect(result.valid).toBe(true);
    expect(result.permissions).toEqual(['TRD_GRP_054']);
    expect(result.restrictions).toBeUndefined();
    expect(signed).toHaveBeenCalledTimes(1);
    expect(signed).toHaveBeenCalledWith('/api/v3/account', 'k', 's');
  });

  it('accepts a key that can trade and is not IP restricted', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, OK_RESTRICTIONS);

    const result = await service.verifyApiKey('k', 's', { requireTrading: true });

    expect(result.valid).toBe(true);
    expect(result.restrictions).toEqual(OK_RESTRICTIONS);
    expect(signed).toHaveBeenCalledWith('/sapi/v1/account/apiRestrictions', 'k', 's');
  });

  it('rejects a read-only key with a trading-permission message', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, { ...OK_RESTRICTIONS, enableSpotAndMarginTrading: false });

    const call = service.verifyApiKey('k', 's', { requireTrading: true });

    await expect(call).rejects.toBeInstanceOf(InvalidApiKeyException);
    await expect(call).rejects.toThrow(/Enable Spot & Margin Trading/);
    await expect(call).rejects.toThrow(/trading permission/);
  });

  it('rejects an IP-restricted key with an IP message the onboarding page keeps verbatim', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, { ...OK_RESTRICTIONS, ipRestrict: true });

    const call = service.verifyApiKey('k', 's', { requireTrading: true });

    await expect(call).rejects.toBeInstanceOf(InvalidApiKeyException);
    await expect(call).rejects.toThrow(/IP/);
    // The onboarding page only shows backend text containing "IP" when it is
    // longer than 60 chars, and swaps anything containing "permission" for a
    // generic hint, so the IP message must be long and must not say "permission".
    const err = await call.catch((e) => e);
    const message: string = err.getResponse().message;
    expect(message.length).toBeGreaterThan(60);
    expect(message).not.toMatch(/permission/i);
  });

  it('checks trading permission before IP restriction when both are wrong', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, { ...OK_RESTRICTIONS, ipRestrict: true, enableSpotAndMarginTrading: false });

    await expect(service.verifyApiKey('k', 's', { requireTrading: true })).rejects.toThrow(
      /trading permission/,
    );
  });

  it('still verifies when the restrictions endpoint fails for a non-auth reason', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, new Error('sapi unavailable'));

    const result = await service.verifyApiKey('k', 's', { requireTrading: true });

    expect(result.valid).toBe(true);
    expect(result.restrictions).toBeUndefined();
  });

  it('still verifies when the restrictions payload is malformed', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, { unexpected: true });

    const result = await service.verifyApiKey('k', 's', { requireTrading: true });

    expect(result.valid).toBe(true);
    expect(result.restrictions).toBeUndefined();
  });

  it('propagates auth and rate-limit errors from the restrictions endpoint', async () => {
    const { service, signed } = makeService();
    routeSigned(signed, new InvalidApiKeyException('bad key'));
    await expect(service.verifyApiKey('k', 's', { requireTrading: true })).rejects.toBeInstanceOf(
      InvalidApiKeyException,
    );

    routeSigned(signed, new BinanceRateLimitException('slow down'));
    await expect(service.verifyApiKey('k', 's', { requireTrading: true })).rejects.toBeInstanceOf(
      BinanceRateLimitException,
    );
  });
});
