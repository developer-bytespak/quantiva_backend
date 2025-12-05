import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearDatabase() {
  console.log('Starting database cleanup...');
  console.log('⚠️  WARNING: This will delete ALL records except prisma_migrations!');

  try {
    // Delete in order to respect foreign key constraints
    // Start with the most dependent tables (children) and work up to parents

    console.log('Deleting order_executions...');
    await prisma.order_executions.deleteMany();

    console.log('Deleting signal_details...');
    await prisma.signal_details.deleteMany();

    console.log('Deleting signal_explanations...');
    await prisma.signal_explanations.deleteMany();

    console.log('Deleting auto_trade_evaluations...');
    await prisma.auto_trade_evaluations.deleteMany();

    console.log('Deleting orders...');
    await prisma.orders.deleteMany();

    console.log('Deleting rebalance_suggestions...');
    await prisma.rebalance_suggestions.deleteMany();

    console.log('Deleting optimization_allocations...');
    await prisma.optimization_allocations.deleteMany();

    console.log('Deleting optimization_runs...');
    await prisma.optimization_runs.deleteMany();

    console.log('Deleting drawdown_history...');
    await prisma.drawdown_history.deleteMany();

    console.log('Deleting portfolio_snapshots...');
    await prisma.portfolio_snapshots.deleteMany();

    console.log('Deleting portfolio_positions...');
    await prisma.portfolio_positions.deleteMany();

    console.log('Deleting portfolios...');
    await prisma.portfolios.deleteMany();

    console.log('Deleting strategy_execution_jobs...');
    await prisma.strategy_execution_jobs.deleteMany();

    console.log('Deleting strategy_parameters...');
    await prisma.strategy_parameters.deleteMany();

    console.log('Deleting strategy_signals...');
    await prisma.strategy_signals.deleteMany();

    console.log('Deleting strategies...');
    await prisma.strategies.deleteMany();

    console.log('Deleting risk_events...');
    await prisma.risk_events.deleteMany();

    console.log('Deleting user_subscriptions...');
    await prisma.user_subscriptions.deleteMany();

    console.log('Deleting user_exchange_connections...');
    await prisma.user_exchange_connections.deleteMany();

    console.log('Deleting kyc_face_matches...');
    await prisma.kyc_face_matches.deleteMany();

    console.log('Deleting kyc_documents...');
    await prisma.kyc_documents.deleteMany();

    console.log('Deleting kyc_verifications...');
    await prisma.kyc_verifications.deleteMany();

    console.log('Deleting user_settings...');
    await prisma.user_settings.deleteMany();

    console.log('Deleting two_factor_codes...');
    await prisma.two_factor_codes.deleteMany();

    console.log('Deleting user_sessions...');
    await prisma.user_sessions.deleteMany();

    console.log('Deleting users...');
    await prisma.users.deleteMany();

    console.log('Deleting market_rankings...');
    await prisma.market_rankings.deleteMany();

    console.log('Deleting trending_assets...');
    await prisma.trending_assets.deleteMany();

    console.log('Deleting trending_news...');
    await prisma.trending_news.deleteMany();

    console.log('Deleting asset_market_data...');
    await prisma.asset_market_data.deleteMany();

    console.log('Deleting asset_metrics...');
    await prisma.asset_metrics.deleteMany();

    console.log('Deleting assets...');
    await prisma.assets.deleteMany();

    console.log('Deleting macro_indicator_values...');
    await prisma.macro_indicator_values.deleteMany();

    console.log('Deleting macro_indicators...');
    await prisma.macro_indicators.deleteMany();

    console.log('Deleting sentiment_analyses...');
    await prisma.sentiment_analyses.deleteMany();

    console.log('Deleting subscription_plans...');
    await prisma.subscription_plans.deleteMany();

    console.log('Deleting exchanges...');
    await prisma.exchanges.deleteMany();

    console.log('✅ Database cleanup completed successfully!');
    console.log('ℹ️  prisma_migrations table was preserved.');
  } catch (error) {
    console.error('❌ Error during database cleanup:', error);
    throw error;
  }
}

clearDatabase()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

