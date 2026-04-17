/**
 * Detects which cryptocurrency an article title is primarily about.
 *
 * Used by the general-crypto bulk news cron to tag each article with a
 * specific ticker (BTC, ETH, SOL, ...) when a coin is mentioned, so the
 * frontend can display the right chip instead of the generic "CRYPTO".
 *
 * Design notes:
 *   - Priority-ordered: majors first. If an article mentions both Bitcoin
 *     and some altcoin, Bitcoin wins (matches human intuition about the
 *     primary topic of a news headline).
 *   - Word-boundary, case-insensitive regex. "ETH" will not match "ETHICAL",
 *     "SOL" will not match "SOLUTION", etc.
 *   - **Ambiguous tickers** (coins whose symbol collides with English words)
 *     only match when paired with crypto-context words like "coin", "token",
 *     "price", "crypto", "rally", "surge" OR when the ticker appears in
 *     ALL CAPS. Prevents embarrassing false positives on prose that happens
 *     to contain those words.
 *   - Zero runtime dependencies. Pure function.
 */

interface CoinPattern {
  /** Ticker to return when this pattern matches. */
  symbol: string;
  /**
   * Pattern tested against the title. For ambiguous tickers, this is the
   * "strict" form (ALL CAPS ticker or paired with crypto context). For
   * unambiguous coins, this matches both the ticker and the full name.
   */
  pattern: RegExp;
}

/**
 * Context words that, when paired with an ambiguous ticker, signal the article
 * is actually about crypto. Used to build strict regexes for ambiguous tickers.
 */
const CRYPTO_CONTEXT =
  '(?:coin|token|price|crypto|rally|surge|pump|dump|dip|rebound|blockchain|defi|staking|holders|airdrop|mint)';

/**
 * Helper to build a "strict" regex for an ambiguous ticker: requires the
 * ticker in ALL CAPS OR adjacent (within ~4 words) to a crypto-context word.
 */
function strict(symbol: string): RegExp {
  const up = symbol.toUpperCase();
  // Match ALL CAPS ticker, or lowercase/mixed when near a context word.
  return new RegExp(
    // ALL CAPS with word boundaries
    `\\b${up}\\b` +
      `|` +
      // any case, near context (either side, within ~30 chars)
      `\\b${up}\\b(?=.{0,40}\\b${CRYPTO_CONTEXT}\\b)` +
      `|` +
      `\\b${CRYPTO_CONTEXT}\\b.{0,40}\\b${up}\\b`,
    '', // intentionally case-sensitive for the ALL CAPS branch
  );
}

/**
 * Top-~100 coins by market cap and relevance.
 * Ordered majors-first so they take priority on ambiguous matches.
 *
 * Safelist (ambiguous ticker, strict match only):
 *   KEY, SUN, WIN, LINK, SAND, ORN, BAL, SNX, YFI, ARK, CAKE, ONE,
 *   JET, CORE, HOT, FLOW, ICE, GAS
 */
export const COIN_PATTERNS: CoinPattern[] = [
  // ============ Top 10 majors ============
  { symbol: 'BTC', pattern: /\b(BTC|Bitcoin)\b/i },
  { symbol: 'ETH', pattern: /\b(ETH|Ethereum|Ether(?!eum))\b/i },
  { symbol: 'USDT', pattern: /\b(USDT|Tether)\b/i },
  { symbol: 'BNB', pattern: /\b(BNB|Binance Coin)\b/i },
  { symbol: 'SOL', pattern: /\b(SOL|Solana)\b/i },
  { symbol: 'USDC', pattern: /\b(USDC|USD Coin)\b/i },
  { symbol: 'XRP', pattern: /\b(XRP|Ripple)\b/i },
  { symbol: 'DOGE', pattern: /\b(DOGE|Dogecoin)\b/i },
  { symbol: 'ADA', pattern: /\b(ADA|Cardano)\b/i },
  { symbol: 'TRX', pattern: /\b(TRX|Tron|TRON)\b/i },

  // ============ 11-30 ============
  { symbol: 'AVAX', pattern: /\b(AVAX|Avalanche)\b/i },
  { symbol: 'SHIB', pattern: /\b(SHIB|Shiba Inu|Shiba)\b/i },
  { symbol: 'DOT', pattern: /\b(DOT|Polkadot)\b/i },
  { symbol: 'BCH', pattern: /\b(BCH|Bitcoin Cash)\b/i },
  { symbol: 'MATIC', pattern: /\b(MATIC|Polygon)\b/i },
  { symbol: 'LTC', pattern: /\b(LTC|Litecoin)\b/i },
  { symbol: 'UNI', pattern: /\b(UNI|Uniswap)\b/i },
  { symbol: 'PEPE', pattern: /\b(PEPE|Pepe Coin|Pepecoin)\b/i },
  { symbol: 'LINK', pattern: strict('LINK') }, // ambiguous
  { symbol: 'KAS', pattern: /\b(KAS|Kaspa)\b/i },
  { symbol: 'ICP', pattern: /\b(ICP|Internet Computer)\b/i },
  { symbol: 'XMR', pattern: /\b(XMR|Monero)\b/i },
  { symbol: 'APT', pattern: /\b(APT|Aptos)\b/i },
  { symbol: 'ETC', pattern: /\b(ETC|Ethereum Classic)\b/i },
  { symbol: 'STX', pattern: /\b(STX|Stacks)\b/i },
  { symbol: 'NEAR', pattern: /\b(NEAR Protocol|Near Protocol)\b/i },
  { symbol: 'ATOM', pattern: /\b(ATOM|Cosmos)\b/i },
  { symbol: 'FIL', pattern: /\b(FIL|Filecoin)\b/i },
  { symbol: 'XLM', pattern: /\b(XLM|Stellar)\b/i },
  { symbol: 'TON', pattern: /\b(TON|Toncoin)\b/i },

  // ============ 31-60 ============
  { symbol: 'HBAR', pattern: /\b(HBAR|Hedera)\b/i },
  { symbol: 'VET', pattern: /\b(VET|VeChain)\b/i },
  { symbol: 'ARB', pattern: /\b(ARB|Arbitrum)\b/i },
  { symbol: 'MKR', pattern: /\b(MKR|Maker)\b/i },
  { symbol: 'GRT', pattern: /\b(GRT|The Graph)\b/i },
  { symbol: 'INJ', pattern: /\b(INJ|Injective)\b/i },
  { symbol: 'IMX', pattern: /\b(IMX|Immutable)\b/i },
  { symbol: 'OP', pattern: /\b(Optimism)\b/i }, // OP alone is too ambiguous
  { symbol: 'LDO', pattern: /\b(LDO|Lido DAO|Lido Finance)\b/i },
  { symbol: 'SUI', pattern: /\b(SUI|Sui Network)\b/i },
  { symbol: 'TIA', pattern: /\b(TIA|Celestia)\b/i },
  { symbol: 'CRO', pattern: /\b(CRO|Cronos)\b/i },
  { symbol: 'AAVE', pattern: /\b(AAVE|Aave)\b/i },
  { symbol: 'ALGO', pattern: /\b(ALGO|Algorand)\b/i },
  { symbol: 'QNT', pattern: /\b(QNT|Quant)\b/i },
  { symbol: 'RUNE', pattern: /\b(RUNE|Thorchain|THORChain)\b/i },
  { symbol: 'FLOW', pattern: strict('FLOW') }, // ambiguous
  { symbol: 'SEI', pattern: /\b(Sei Network)\b/i }, // SEI alone is too short
  { symbol: 'RNDR', pattern: /\b(RNDR|Render Token|Render Network)\b/i },
  { symbol: 'FET', pattern: /\b(FET|Fetch\.ai|Fetch AI)\b/i },
  { symbol: 'EGLD', pattern: /\b(EGLD|MultiversX|Elrond)\b/i },
  { symbol: 'SAND', pattern: strict('SAND') }, // ambiguous
  { symbol: 'THETA', pattern: /\b(THETA|Theta Network|Theta Token)\b/i },
  { symbol: 'MANA', pattern: /\b(MANA|Decentraland)\b/i },
  { symbol: 'AXS', pattern: /\b(AXS|Axie Infinity)\b/i },
  { symbol: 'XTZ', pattern: /\b(XTZ|Tezos)\b/i },
  { symbol: 'BSV', pattern: /\b(BSV|Bitcoin SV)\b/i },
  { symbol: 'CHZ', pattern: /\b(CHZ|Chiliz)\b/i },
  { symbol: 'PYTH', pattern: /\b(PYTH|Pyth Network)\b/i },
  { symbol: 'KCS', pattern: /\b(KCS|KuCoin Token)\b/i },

  // ============ 61-100 ============
  { symbol: 'FTM', pattern: /\b(FTM|Fantom)\b/i },
  { symbol: 'MINA', pattern: /\b(MINA Protocol|Mina Protocol)\b/i },
  { symbol: 'NEO', pattern: /\b(NEO Token|NEO Coin)\b/i }, // NEO too ambiguous alone
  { symbol: 'WLD', pattern: /\b(WLD|Worldcoin)\b/i },
  { symbol: 'BONK', pattern: /\b(BONK)\b/i },
  { symbol: 'WIF', pattern: /\b(WIF|dogwifhat)\b/i },
  { symbol: 'FLOKI', pattern: /\b(FLOKI|Floki Inu)\b/i },
  { symbol: 'JUP', pattern: /\b(JUP|Jupiter Exchange)\b/i },
  { symbol: 'TAO', pattern: /\b(TAO|Bittensor)\b/i },
  { symbol: 'ONDO', pattern: /\b(ONDO)\b/i },
  { symbol: 'ORDI', pattern: /\b(ORDI|Ordinals)\b/i },
  { symbol: 'DYDX', pattern: /\b(DYDX|dYdX)\b/i },
  { symbol: 'GMX', pattern: /\b(GMX)\b/i },
  { symbol: 'GALA', pattern: /\b(GALA|Gala Games)\b/i },
  { symbol: 'SNX', pattern: strict('SNX') },
  { symbol: 'COMP', pattern: /\b(Compound Finance|Compound Token)\b/i }, // COMP/Compound alone too ambiguous
  { symbol: 'CRV', pattern: /\b(CRV|Curve DAO)\b/i },
  { symbol: 'CAKE', pattern: strict('CAKE') }, // ambiguous
  { symbol: 'YFI', pattern: strict('YFI') },
  { symbol: 'ENJ', pattern: /\b(ENJ|Enjin)\b/i },
  { symbol: 'BAT', pattern: /\b(BAT Token|Basic Attention Token)\b/i }, // BAT alone too ambiguous
  { symbol: 'ZEC', pattern: /\b(ZEC|Zcash)\b/i },
  { symbol: 'DASH', pattern: /\b(DASH Token|DASH Coin)\b/i }, // DASH alone ambiguous
  { symbol: 'KSM', pattern: /\b(KSM|Kusama)\b/i },
  { symbol: 'CELO', pattern: /\b(Celo Network|CELO Token)\b/i },
  { symbol: 'ENS', pattern: /\b(ENS|Ethereum Name Service)\b/i },
  { symbol: 'ROSE', pattern: /\b(ROSE|Oasis Network)\b/i },
  { symbol: 'BLUR', pattern: /\b(BLUR|Blur Protocol|Blur Token)\b/i },
  { symbol: 'GMT', pattern: /\b(GMT Token|Stepn)\b/i }, // GMT alone = timezone
  { symbol: '1INCH', pattern: /\b(1INCH|1inch)\b/i },
  { symbol: 'ZRX', pattern: /\b(ZRX|0x Protocol)\b/i },
  { symbol: 'CVX', pattern: /\b(CVX|Convex Finance)\b/i },
  { symbol: 'DYM', pattern: /\b(DYM|Dymension)\b/i },
  { symbol: 'STRK', pattern: /\b(STRK|Starknet|StarkNet)\b/i },
  { symbol: 'PENDLE', pattern: /\b(PENDLE|Pendle Finance)\b/i },
  { symbol: 'JASMY', pattern: /\b(JASMY|JasmyCoin)\b/i },
  { symbol: 'RPL', pattern: /\b(RPL|Rocket Pool)\b/i },
  { symbol: 'SUSHI', pattern: /\b(SUSHI|SushiSwap)\b/i },
  { symbol: 'BAL', pattern: strict('BAL') },
  { symbol: 'KEY', pattern: strict('KEY') },
  { symbol: 'SUN', pattern: strict('SUN') },
  { symbol: 'WIN', pattern: strict('WIN') },
  { symbol: 'ORN', pattern: strict('ORN') },
  { symbol: 'ARK', pattern: strict('ARK') },
  { symbol: 'HOT', pattern: strict('HOT') },
  { symbol: 'ICE', pattern: strict('ICE') },
  { symbol: 'JET', pattern: strict('JET') },
  { symbol: 'CORE', pattern: strict('CORE') },
  { symbol: 'GAS', pattern: strict('GAS') },
  { symbol: 'ONE', pattern: strict('ONE') },
];

/**
 * Return the ticker of the first coin mentioned in `title`, or null if none
 * of the known patterns match.
 *
 * Examples:
 *   detectCoin("Bitcoin Hits New All-Time High")     -> "BTC"
 *   detectCoin("Ethereum 2.0 Upgrade Goes Live")     -> "ETH"
 *   detectCoin("Tom Lee: Crypto Drop is Healthy")    -> null
 *   detectCoin("Sun Sets Over Coast")                -> null  (ambiguous SUN rejected)
 *   detectCoin("SUN token rallies 20% this week")    -> "SUN" (ALL CAPS ticker)
 */
export function detectCoin(title: string): string | null {
  if (!title) return null;
  for (const { symbol, pattern } of COIN_PATTERNS) {
    if (pattern.test(title)) {
      return symbol;
    }
  }
  return null;
}
