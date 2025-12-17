declare module '@prisma/client' {
  export type KycStatus = 'pending' | 'approved' | 'rejected' | 'review'
  export const KycStatus: { pending: KycStatus; approved: KycStatus; rejected: KycStatus; review: KycStatus }

  export type RiskTolerance = 'low' | 'medium' | 'high'
  export const RiskTolerance: { low: RiskTolerance; medium: RiskTolerance; high: RiskTolerance }

  export type ExchangeType = 'crypto' | 'stocks'
  export const ExchangeType: { crypto: ExchangeType; stocks: ExchangeType }

  export type StrategyType = 'admin' | 'user'
  export const StrategyType: { admin: StrategyType; user: StrategyType }

  export type RiskLevel = 'low' | 'medium' | 'high'
  export const RiskLevel: { low: RiskLevel; medium: RiskLevel; high: RiskLevel }

  export type SignalAction = 'BUY' | 'SELL' | 'HOLD'
  export const SignalAction: { BUY: SignalAction; SELL: SignalAction; HOLD: SignalAction }

  export type ConnectionStatus = 'pending' | 'active' | 'invalid' | 'revoked'
  export const ConnectionStatus: { pending: ConnectionStatus; active: ConnectionStatus; invalid: ConnectionStatus; revoked: ConnectionStatus }

  export type PortfolioType = 'spot' | 'futures' | 'margin'
  export const PortfolioType: { spot: PortfolioType; futures: PortfolioType; margin: PortfolioType }

  export type PositionSide = 'long' | 'short'
  export const PositionSide: { long: PositionSide; short: PositionSide }

  export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'
  export const OrderType: { market: OrderType; limit: OrderType; stop: OrderType; stop_limit: OrderType }

  export type OrderStatus = 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected'
  export const OrderStatus: { pending: OrderStatus; filled: OrderStatus; partially_filled: OrderStatus; cancelled: OrderStatus; rejected: OrderStatus }

  export type SubscriptionStatus = 'active' | 'cancelled' | 'trial' | 'expired'
  export const SubscriptionStatus: { active: SubscriptionStatus; cancelled: SubscriptionStatus; trial: SubscriptionStatus; expired: SubscriptionStatus }

  export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'
  export const JobStatus: { pending: JobStatus; running: JobStatus; completed: JobStatus; failed: JobStatus }

  export type NewsSource = 'StockNewsAPI' | 'LunarCrush'
  export const NewsSource: { StockNewsAPI: NewsSource; LunarCrush: NewsSource }

  export type SentimentLabel = 'positive' | 'negative' | 'neutral'
  export const SentimentLabel: { positive: SentimentLabel; negative: SentimentLabel; neutral: SentimentLabel }
  export class PrismaClient {
    constructor(...args: any[])
    $connect(): Promise<void>
    $disconnect(): Promise<void>
    [key: string]: any
  }
  export type PrismaClient = PrismaClient
}
