import { RiskLevel } from '@prisma/client';

/**
 * Option B pre-built strategy templates — one per index.
 *
 * Each template has a `target_index_code` that the stock signals cron will
 * use to filter its universe (only stocks whose index_membership matches
 * are evaluated for that strategy).
 *
 * Weights are normalized to sum to 1.0. Entry/exit rules use the engine
 * output paths documented in ENGINE_ARCHITECTURE.md §6.
 */

export interface OptionBStrategyTemplate {
  name: string;
  description: string;
  risk_level: RiskLevel;
  target_index_code: string;
  engine_weights: {
    sentiment: number;
    trend: number;
    fundamental: number;
    event_risk: number;
    liquidity: number;
  };
  entry_rules: Array<{ field: string; operator: string; value: number }>;
  exit_rules: Array<{ field: string; operator: string; value: number }>;
  stop_loss_value: number;
  take_profit_value: number;
}

export const OPTION_B_STRATEGIES: OptionBStrategyTemplate[] = [
  {
    name: 'S&P 500 Stability',
    description:
      'Low-risk strategy targeting the S&P 500. Prioritizes financial quality and stability over momentum. Best for users who want steady, conservative blue-chip exposure.',
    risk_level: 'low',
    target_index_code: 'SP500',
    engine_weights: {
      trend: 0.20,
      sentiment: 0.20,
      fundamental: 0.35,
      event_risk: 0.20,
      liquidity: 0.05,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.25 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 5.0,
    take_profit_value: 10.0,
  },
  {
    name: 'Dow Blue Chip Dividend',
    description:
      'Income-focused strategy targeting the 30 Dow Jones blue chips. Heavy weight on fundamental quality and event risk avoidance. Best for users seeking dividend stability.',
    risk_level: 'low',
    target_index_code: 'DOW',
    engine_weights: {
      trend: 0.15,
      sentiment: 0.15,
      fundamental: 0.40,
      event_risk: 0.25,
      liquidity: 0.05,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.25 },
      { field: 'metadata.engine_details.fundamental.score', operator: '>', value: 0.10 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 4.0,
    take_profit_value: 8.0,
  },
  {
    name: 'Russell 1000 Balanced',
    description:
      'Balanced strategy across the top 1000 US companies. Equal-ish weight on all factors — no single engine dominates. Best for users who want diversified exposure.',
    risk_level: 'medium',
    target_index_code: 'RUSSELL_1000',
    engine_weights: {
      trend: 0.20,
      sentiment: 0.20,
      fundamental: 0.25,
      event_risk: 0.20,
      liquidity: 0.15,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.25 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 5.0,
    take_profit_value: 10.0,
  },
  {
    name: 'Mid-Cap Growth',
    description:
      'Growth strategy targeting the S&P MidCap 400. Heavy weight on trend and sentiment — momentum matters more for mid-caps. Selective: only fires on stronger setups.',
    risk_level: 'medium',
    target_index_code: 'SP_MIDCAP_400',
    engine_weights: {
      trend: 0.30,
      sentiment: 0.30,
      fundamental: 0.20,
      event_risk: 0.15,
      liquidity: 0.05,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.30 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 7.0,
    take_profit_value: 15.0,
  },
  {
    name: 'Russell 2000 Small-Cap Momentum',
    description:
      'High-risk/high-reward momentum strategy on Russell 2000 small caps. Liquidity is already gated upstream by signal_eligible (market_cap and dollar-volume floors), so this strategy itself only checks final_score.',
    risk_level: 'high',
    target_index_code: 'RUSSELL_2000',
    engine_weights: {
      trend: 0.30,
      sentiment: 0.20,
      fundamental: 0.15,
      event_risk: 0.15,
      liquidity: 0.20,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.30 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.15 },
    ],
    stop_loss_value: 10.0,
    take_profit_value: 20.0,
  },
  {
    name: 'Nasdaq Growth Pulse',
    description:
      'News-driven tech/growth strategy on the Nasdaq Composite. Sentiment-heavy — tech stocks move on news flow. Trend-aware to catch momentum.',
    risk_level: 'high',
    target_index_code: 'NASDAQ_COMPOSITE',
    engine_weights: {
      trend: 0.25,
      sentiment: 0.40,
      fundamental: 0.15,
      event_risk: 0.10,
      liquidity: 0.10,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.30 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 8.0,
    take_profit_value: 15.0,
  },
  {
    name: 'NYSE Mid-Cap Value',
    description:
      'Old-school value strategy targeting NYSE/AMEX listed stocks. Fundamental quality first, momentum second. Best for users hunting undervalued established companies.',
    risk_level: 'medium',
    target_index_code: 'NYSE_AMEX',
    engine_weights: {
      trend: 0.15,
      sentiment: 0.15,
      fundamental: 0.40,
      event_risk: 0.20,
      liquidity: 0.10,
    },
    entry_rules: [
      { field: 'final_score', operator: '>', value: 0.25 },
      { field: 'metadata.engine_details.fundamental.score', operator: '>', value: 0.10 },
    ],
    exit_rules: [
      { field: 'final_score', operator: '<', value: -0.20 },
    ],
    stop_loss_value: 5.0,
    take_profit_value: 12.0,
  },
];
