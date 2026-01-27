import { RiskLevel } from '@prisma/client';

export interface PreBuiltStrategyTemplate {
  name: string;
  description: string;
  risk_level: RiskLevel;
  engine_weights: {
    sentiment: number;
    trend: number;
    fundamental: number;
    event_risk: number;
    liquidity: number;
  };
  entry_rules: any[];
  exit_rules: any[];
  stop_loss_value: number;
  take_profit_value: number;
}

export const PRE_BUILT_STRATEGIES: PreBuiltStrategyTemplate[] = [
  {
    name: 'Trend + Sentiment',
    description:
      'Focuses on sentiment analysis and trend following. Ideal for capturing momentum driven by market sentiment and technical trends.',
    risk_level: 'medium',
    engine_weights: {
      sentiment: 0.5,
      trend: 0.4,
      fundamental: 0.05,
      event_risk: 0.03,
      liquidity: 0.02,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.3,
      },
      {
        field: 'metadata.engine_details.sentiment.metadata.ema.momentum',
        operator: '>',
        value: 0.1,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.2,
      },
    ],
    stop_loss_value: 5.0,
    take_profit_value: 10.0,
  },
  {
    name: 'Alpha Fusion',
    description:
      'Balanced approach combining all engines with emphasis on sentiment and trend. Designed for consistent alpha generation across market conditions.',
    risk_level: 'medium',
    engine_weights: {
      sentiment: 0.35,
      trend: 0.25,
      fundamental: 0.15,
      event_risk: 0.15,
      liquidity: 0.1,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.25,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.15,
      },
    ],
    stop_loss_value: 4.0,
    take_profit_value: 8.0,
  },
  {
    name: 'Liquidity Adaptive',
    description:
      'Prioritizes liquidity and market depth. Best for large positions and minimizing slippage in volatile markets.',
    risk_level: 'low',
    engine_weights: {
      sentiment: 0.3,
      trend: 0.2,
      fundamental: 0.1,
      event_risk: 0.1,
      liquidity: 0.3,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.2,
      },
      {
        field: 'metadata.engine_details.liquidity.score',
        operator: '>',
        value: 0.5,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.1,
      },
    ],
    stop_loss_value: 3.0,
    take_profit_value: 6.0,
  },
  {
    name: 'Event Guard',
    description:
      'Heavy focus on event risk management. Protects against adverse events while maintaining exposure to opportunities.',
    risk_level: 'high',
    engine_weights: {
      sentiment: 0.25,
      trend: 0.2,
      fundamental: 0.2,
      event_risk: 0.3,
      liquidity: 0.05,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.3,
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '>',
        value: -0.2,
      },
    ],
    exit_rules: [
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '<',
        value: -0.5,
      },
    ],
    stop_loss_value: 6.0,
    take_profit_value: 12.0,
  },
  // ============================================
  // STOCK-SPECIFIC STRATEGIES (0.5/-0.5 thresholds)
  // These strategies are designed for equities with
  // more conservative entry/exit rules than crypto
  // ============================================
  {
    name: 'Conservative Growth (Stocks)',
    description:
      'Stock-focused strategy emphasizing fundamental analysis and earnings quality. Targets stable companies with strong financials, positive earnings momentum, and low event risk. Ideal for long-term investors seeking steady growth.',
    risk_level: 'low',
    engine_weights: {
      sentiment: 0.25,
      trend: 0.15,
      fundamental: 0.35,
      event_risk: 0.2,
      liquidity: 0.05,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.5, // Stock threshold - requires higher conviction
      },
      {
        field: 'metadata.engine_details.fundamental.score',
        operator: '>',
        value: 0.4, // Strong fundamentals required
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '>',
        value: -0.2, // Avoid stocks with high event risk
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '>',
        value: -0.1, // Not in strong downtrend
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.3,
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '<',
        value: -0.5, // Exit on high-risk events (earnings miss, scandals)
      },
    ],
    stop_loss_value: 4.0, // Tighter stop-loss for capital preservation
    take_profit_value: 15.0, // Higher target for quality stocks
  },
  {
    name: 'Tech Momentum (Stocks)',
    description:
      'High-conviction strategy for growth stocks with strong technical momentum and positive sentiment. Ideal for tech sector and momentum plays. Requires strong social buzz and upward price action.',
    risk_level: 'high',
    engine_weights: {
      sentiment: 0.4,
      trend: 0.35,
      fundamental: 0.1,
      event_risk: 0.1,
      liquidity: 0.05,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.5, // Stock threshold
      },
      {
        field: 'metadata.engine_details.sentiment.score',
        operator: '>',
        value: 0.4, // Strong positive sentiment required
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '>',
        value: 0.35, // Must be in clear uptrend
      },
      {
        field: 'metadata.engine_details.liquidity.score',
        operator: '>',
        value: 0.3, // Ensure adequate volume for momentum plays
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.4, // Exit faster on momentum reversal
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '<',
        value: -0.3, // Exit when momentum reverses
      },
    ],
    stop_loss_value: 7.0, // Slightly tighter to protect gains
    take_profit_value: 20.0, // Higher target for momentum plays
  },
  {
    name: 'Value Investing (Stocks)',
    description:
      'Fundamental-driven strategy focusing on undervalued stocks with strong fundamentals. Emphasizes P/E ratios, earnings quality, and revenue growth. Looks for temporary dips in quality companies.',
    risk_level: 'medium',
    engine_weights: {
      sentiment: 0.15,
      trend: 0.1,
      fundamental: 0.5,
      event_risk: 0.2,
      liquidity: 0.05,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.5, // Stock threshold
      },
      {
        field: 'metadata.engine_details.fundamental.score',
        operator: '>',
        value: 0.5, // Strong fundamentals required
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '<',
        value: 0.3, // Look for dips - not overbought
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '>',
        value: -0.3, // Avoid distressed companies
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.6, // More patient exit for value plays
      },
    ],
    stop_loss_value: 5.0, // Moderate stop-loss
    take_profit_value: 18.0, // Higher target for value plays (longer hold)
  },
  {
    name: 'Dividend Income (Stocks)',
    description:
      'Conservative strategy for dividend-paying stocks with stable fundamentals. Focuses on consistent earnings, low event risk, and strong financial health. Prioritizes capital preservation and steady income.',
    risk_level: 'low',
    engine_weights: {
      sentiment: 0.2,
      trend: 0.15,
      fundamental: 0.4,
      event_risk: 0.2,
      liquidity: 0.05,
    },
    entry_rules: [
      {
        field: 'final_score',
        operator: '>',
        value: 0.5, // Stock threshold
      },
      {
        field: 'metadata.engine_details.fundamental.score',
        operator: '>',
        value: 0.45, // Strong fundamentals for dividend stability
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '>',
        value: 0.1, // Positive outlook required (no earnings warnings)
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '>',
        value: -0.2, // Not in significant downtrend
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.35,
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '<',
        value: -0.3, // Exit on dividend cut risk or earnings miss
      },
    ],
    stop_loss_value: 3.0, // Tightest stop-loss - protect income capital
    take_profit_value: 12.0, // Moderate target for dividend stocks
  },
];

