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

