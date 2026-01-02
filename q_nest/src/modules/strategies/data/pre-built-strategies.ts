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
  // Stock-specific strategies with 0.5/-0.5 thresholds
  {
    name: 'Conservative Growth (Stocks)',
    description:
      'Stock-focused strategy emphasizing fundamental analysis and earnings quality. Targets stable companies with strong financials and positive earnings momentum.',
    risk_level: 'low',
    engine_weights: {
      sentiment: 0.25,
      trend: 0.2,
      fundamental: 0.35,
      event_risk: 0.15,
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
        value: 0.3,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.3,
      },
    ],
    stop_loss_value: 5.0,
    take_profit_value: 12.0,
  },
  {
    name: 'Tech Momentum (Stocks)',
    description:
      'High-conviction strategy for growth stocks with strong technical momentum and positive sentiment. Ideal for tech sector and momentum plays.',
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
        value: 0.4,
      },
      {
        field: 'metadata.engine_details.trend.score',
        operator: '>',
        value: 0.3,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.5, // Stock threshold
      },
    ],
    stop_loss_value: 8.0,
    take_profit_value: 18.0,
  },
  {
    name: 'Value Investing (Stocks)',
    description:
      'Fundamental-driven strategy focusing on undervalued stocks with strong fundamentals. Emphasizes P/E ratios, earnings quality, and revenue growth.',
    risk_level: 'medium',
    engine_weights: {
      sentiment: 0.15,
      trend: 0.15,
      fundamental: 0.45,
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
        value: 0.5,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.5, // Stock threshold
      },
    ],
    stop_loss_value: 6.0,
    take_profit_value: 15.0,
  },
  {
    name: 'Dividend Income (Stocks)',
    description:
      'Conservative strategy for dividend-paying stocks with stable fundamentals. Focuses on consistent earnings, low event risk, and strong financial health.',
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
        value: 0.4,
      },
      {
        field: 'metadata.engine_details.event_risk.score',
        operator: '>',
        value: 0.0,
      },
    ],
    exit_rules: [
      {
        field: 'final_score',
        operator: '<',
        value: -0.4,
      },
    ],
    stop_loss_value: 4.0,
    take_profit_value: 10.0,
  },
];

