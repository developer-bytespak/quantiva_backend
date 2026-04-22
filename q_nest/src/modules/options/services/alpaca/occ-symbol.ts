/**
 * OCC-21 option symbol normalizer.
 *
 * OCC format (21 chars, space-padded root):
 *   [ROOT 6][YY 2][MM 2][DD 2][C|P 1][STRIKE 8]
 *
 * Examples:
 *   AAPL  240621C00150000  → AAPL, 2024-06-21, CALL, strike 150.000
 *   SPY   240119P00400000  → SPY,  2024-01-19, PUT,  strike 400.000
 *
 * Strike is stored as an integer with 3 decimals implied (× 1000), so
 * "00150000" = 150.000 and "00012500" = 12.500.
 *
 * Alpaca accepts both the padded form (21 chars) and the unpadded form
 * ("AAPL240621C00150000"). We emit the unpadded form because it's what
 * the Alpaca docs use everywhere and it reads cleaner in logs.
 */

import { OptionTypeEnum } from '../../dto/options.dto';

export interface ParsedOccSymbol {
  underlying: string;
  expiry: string; // ISO date (YYYY-MM-DD)
  type: OptionTypeEnum;
  strike: number;
}

const OCC_REGEX = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const STRIKE_SCALE = 1000;

export function parseOccSymbol(symbol: string): ParsedOccSymbol {
  const cleaned = symbol.trim().replace(/\s+/g, '');
  const match = OCC_REGEX.exec(cleaned);
  if (!match) {
    throw new Error(`Invalid OCC option symbol: ${symbol}`);
  }
  const [, root, yy, mm, dd, cp, strikeRaw] = match;
  const year = 2000 + parseInt(yy, 10);
  const expiry = `${year}-${mm}-${dd}`;
  const strike = parseInt(strikeRaw, 10) / STRIKE_SCALE;
  return {
    underlying: root,
    expiry,
    type: cp === 'C' ? OptionTypeEnum.CALL : OptionTypeEnum.PUT,
    strike,
  };
}

export function tryParseOccSymbol(symbol: string): ParsedOccSymbol | null {
  try {
    return parseOccSymbol(symbol);
  } catch {
    return null;
  }
}

export interface BuildOccInput {
  underlying: string;
  expiry: string; // YYYY-MM-DD or ISO datetime
  type: OptionTypeEnum | 'CALL' | 'PUT' | 'C' | 'P';
  strike: number;
}

export function buildOccSymbol({ underlying, expiry, type, strike }: BuildOccInput): string {
  const root = underlying.toUpperCase();
  const datePart = expiry.slice(0, 10).replace(/-/g, '');
  if (datePart.length !== 8) {
    throw new Error(`Invalid expiry for OCC symbol: ${expiry}`);
  }
  const yy = datePart.slice(2, 4);
  const mm = datePart.slice(4, 6);
  const dd = datePart.slice(6, 8);
  const cp = (typeof type === 'string' ? type : String(type)).toUpperCase().startsWith('C') ? 'C' : 'P';
  const strikeInt = Math.round(strike * STRIKE_SCALE);
  if (strikeInt < 0 || strikeInt > 99_999_999) {
    throw new Error(`Strike out of range for OCC encoding: ${strike}`);
  }
  const strikePart = String(strikeInt).padStart(8, '0');
  return `${root}${yy}${mm}${dd}${cp}${strikePart}`;
}
