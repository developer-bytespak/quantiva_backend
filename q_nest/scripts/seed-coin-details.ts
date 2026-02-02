import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CoinDetailsCacheService } from '../src/modules/market/services/coin-details-cache.service';

async function bootstrap() {
  console.log('🚀 Starting coin details seed...');
  
  const app = await NestFactory.createApplicationContext(AppModule);
  const coinDetailsCacheService = app.get(CoinDetailsCacheService);

  try {
    console.log('📥 Syncing top 200 coins from CoinGecko...');
    const result = await coinDetailsCacheService.syncTopCoins(200);
    
    console.log('✅ Sync completed!');
    console.log(`   Success: ${result.success}`);
    console.log(`   Failed: ${result.failed}`);
    
    console.log('\n📊 Cache Statistics:');
    const stats = await coinDetailsCacheService.getCacheStats();
    console.log(`   Total Coins: ${stats.totalCoins}`);
    console.log(`   Fresh Coins: ${stats.freshCoins}`);
    console.log(`   Stale Coins: ${stats.staleCoins}`);
    
  } catch (error) {
    console.error('❌ Failed to seed coin details:', error);
    process.exit(1);
  }

  await app.close();
  console.log('\n✨ Done!');
  process.exit(0);
}

bootstrap();
