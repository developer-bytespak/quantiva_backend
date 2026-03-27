import { PrismaClient, ExchangeType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding exchanges...');

  // Check if Binance already exists
  const existingBinance = await prisma.exchanges.findUnique({
    where: { name: 'Binance' },
  });

  if (!existingBinance) {
    const binance = await prisma.exchanges.create({
      data: {
        name: 'Binance',
        type: ExchangeType.crypto,
        supports_oauth: false,
      },
    });
    console.log('Created Binance exchange:', binance);
  } else {
    console.log('Binance exchange already exists');
  }

  // Check if Bybit exists
  const existingBybit = await prisma.exchanges.findUnique({
    where: { name: 'Bybit' },
  });

  if (!existingBybit) {
    const bybit = await prisma.exchanges.create({
      data: {
        name: 'Bybit',
        type: ExchangeType.crypto,
        supports_oauth: false,
      },
    });
    console.log('Created Bybit exchange:', bybit);
  } else {
    console.log('Bybit exchange already exists');
  }

  // Check if Interactive Brokers exists
  const existingIBKR = await prisma.exchanges.findUnique({
    where: { name: 'Interactive Brokers' },
  });

  if (!existingIBKR) {
    const ibkr = await prisma.exchanges.create({
      data: {
        name: 'Interactive Brokers',
        type: ExchangeType.stocks,
        supports_oauth: false,
      },
    });
    console.log('Created Interactive Brokers exchange:', ibkr);
  } else {
    console.log('Interactive Brokers exchange already exists');
  }

  // Check if Binance.US exists
  const existingBinanceUS = await prisma.exchanges.findUnique({
    where: { name: 'Binance.US' },
  });

  if (!existingBinanceUS) {
    const binanceUS = await prisma.exchanges.create({
      data: {
        name: 'Binance.US',
        type: ExchangeType.crypto,
        supports_oauth: false,
      },
    });
    console.log('Created Binance.US exchange:', binanceUS);
  } else {
    console.log('Binance.US exchange already exists');
  }

  // ─── QHQ Token Config (singleton) ────────────────────────────────────────
  console.log('Seeding QHQ token config...');
  await prisma.qhq_token_config.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      total_supply: 100000000,
      circulating_supply: 0,
      total_burned: 0,
      network: 'base',
    },
  });
  console.log('QHQ token config ready');

  // ─── QHQ Reward Rules ─────────────────────────────────────────────────────
  console.log('Seeding QHQ reward rules...');
  const rewardRules = [
    { rule_key: 'MONTHLY_PRO',       amount: 10,   description: 'Monthly reward for PRO subscribers' },
    { rule_key: 'MONTHLY_ELITE',     amount: 25,   description: 'Monthly reward for ELITE subscribers' },
    { rule_key: 'TRADE_EXECUTED',    amount: 0.1,  description: 'Reward per executed live trade (capped at 10/day)' },
    { rule_key: 'STRATEGY_CREATED',  amount: 5,    description: 'Reward for creating a custom strategy' },
    { rule_key: 'BACKTEST_RUN',      amount: 1,    description: 'Reward for running a backtest' },
    { rule_key: 'REFERRAL_SIGNUP',   amount: 20,   description: 'Reward when referred user subscribes' },
    { rule_key: 'LOYALTY_12_MONTHS', amount: 50,   description: 'One-time bonus for 12 months of tenure' },
  ];

  for (const rule of rewardRules) {
    await prisma.qhq_reward_rules.upsert({
      where: { rule_key: rule.rule_key },
      update: { amount: rule.amount, description: rule.description },
      create: { ...rule, is_active: true },
    });
    console.log(`  ✓ ${rule.rule_key} = ${rule.amount} QHQ`);
  }
  console.log('QHQ reward rules seeded');

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

