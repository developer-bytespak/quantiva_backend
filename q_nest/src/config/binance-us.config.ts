export const binanceUSConfig = {
  baseUrl: 'https://api.binance.us',
  apiEndpoint: 'https://api.binance.us/api',
  wsEndpoint: 'wss://stream.binance.us:9443',
  
  // Optional: Only needed for developer testing. Production uses user-provided API keys.
  // Users enter their own API keys via UI → encrypted → stored in database → passed to service methods
  apiKey: process.env.BINANCE_US_API_KEY || '',
  apiSecret: process.env.BINANCE_US_API_SECRET || '',

  // Features (Binance.US is spot-only, no margin/futures)
  features: {
    enableTrading: true,
    enableMarginTrading: false,
    enableFuturesTrading: false,
  },

  // Rate limiting
  rateLimits: {
    requestWeight: 1200, // Weight per minute
    orderLimit: 100000, // Orders per 24 hours
    requestLimitInterval: 60000, // 1 minute in ms
  },

  // Retry configuration
  retry: {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
  },
};
