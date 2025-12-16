export const binanceTestnetConfig = {
  baseUrl: 'https://testnet.binance.vision',
  apiEndpoint: 'https://testnet.binance.vision/api',
  wsEndpoint: 'wss://stream.testnet.binance.vision:9443',
  
  // Single testnet account credentials from environment variables
  apiKey: process.env.TESTNET_API_KEY || '',
  apiSecret: process.env.TESTNET_API_SECRET || '',

  // Testnet specific settings
  features: {
    enableTrading: process.env.TESTNET_ENABLE_TRADING === 'true',
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

  // Caching
  cache: {
    ttl: 5000, // 5 seconds
    key: 'binance_testnet',
  },
};
