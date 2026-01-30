import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { AlpacaPaperTradingService, AlpacaOrder, AlpacaPosition } from '../alpaca-paper-trading.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

/**
 * Script to check for stock positions without OCO sell orders (bracket orders)
 * and automatically close them to prevent unprotected positions.
 * 
 * This handles edge cases where:
 * - BUY order filled but bracket order legs failed to create
 * - Manual trades without stop-loss/take-profit
 * - System errors during bracket order creation
 * 
 * Run: npm run ts-node -- src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts
 */

async function bootstrap() {
  const logger = new Logger('CloseUnprotectedPositions');
  
  logger.log('🔍 Starting unprotected positions check...');
  
  const app = await NestFactory.createApplicationContext(AppModule);
  const alpacaService = app.get(AlpacaPaperTradingService);
  const prisma = app.get(PrismaService);
  
  try {
    // 1. Get all current positions
    logger.log('📊 Fetching current positions...');
    const positions: AlpacaPosition[] = await alpacaService.getPositions();
    
    if (!positions || positions.length === 0) {
      logger.log('✅ No open positions found. Nothing to check.');
      await app.close();
      return;
    }
    
    logger.log(`Found ${positions.length} open position(s)`);
    
    // 2. Get all orders (including bracket orders with legs)
    logger.log('📋 Fetching all orders...');
    const allOrders: AlpacaOrder[] = await alpacaService.getOrders({ 
      status: 'all',
      nested: true // Include bracket order legs
    });
    
    // 3. Build a map of symbols with active sell orders (TP/SL)
    const symbolsWithSellOrders = new Set<string>();
    
    for (const order of allOrders) {
      // Check if order has bracket legs (TP/SL)
      if (order.order_class === 'bracket' && order.legs && order.legs.length > 0) {
        // If any leg is pending (new, held, accepted), this position is protected
        const hasActiveSellLegs = order.legs.some(leg => 
          leg.side === 'sell' && ['new', 'held', 'accepted', 'pending_new'].includes(leg.status)
        );
        
        if (hasActiveSellLegs) {
          symbolsWithSellOrders.add(order.symbol);
          logger.debug(`✓ ${order.symbol} has active bracket orders`);
        }
      }
      
      // Also check standalone sell orders (limit/stop orders)
      if (order.side === 'sell' && ['new', 'held', 'accepted', 'pending_new'].includes(order.status)) {
        symbolsWithSellOrders.add(order.symbol);
        logger.debug(`✓ ${order.symbol} has active sell order`);
      }
    }
    
    // 4. Find unprotected positions (no sell orders)
    const unprotectedPositions: AlpacaPosition[] = [];
    
    for (const position of positions) {
      if (!symbolsWithSellOrders.has(position.symbol)) {
        unprotectedPositions.push(position);
        logger.warn(`⚠️  UNPROTECTED: ${position.symbol} - Qty: ${position.qty}, Entry: $${position.avg_entry_price}, Current: $${position.current_price}, P/L: ${position.unrealized_plpc}%`);
      } else {
        logger.log(`✅ PROTECTED: ${position.symbol} has sell orders`);
      }
    }
    
    // 5. Close unprotected positions
    if (unprotectedPositions.length === 0) {
      logger.log('✅ All positions are protected with sell orders. No action needed.');
      await app.close();
      return;
    }
    
    logger.warn(`\n🚨 Found ${unprotectedPositions.length} UNPROTECTED position(s). Closing them now...\n`);
    
    const closedPositions: string[] = [];
    const failedPositions: { symbol: string; error: string }[] = [];
    
    for (const position of unprotectedPositions) {
      try {
        logger.log(`🔴 Closing ${position.symbol} - Market sell ${position.qty} shares...`);
        
        const closeOrder = await alpacaService.placeOrder({
          symbol: position.symbol,
          qty: parseFloat(position.qty),
          side: 'sell',
          type: 'market',
          time_in_force: 'day',
        });
        
        logger.log(`✅ Closed ${position.symbol} - Order ID: ${closeOrder.id}`);
        closedPositions.push(position.symbol);
        
        // Log to database for audit trail
        await prisma.auto_trade_logs.create({
          data: {
            session_id: 'UNPROTECTED_CLOSE_SCRIPT',
            event_type: 'POSITION_CLOSED',
            message: `Closed unprotected position: ${position.symbol}`,
            metadata: {
              symbol: position.symbol,
              qty: position.qty,
              entry_price: position.avg_entry_price,
              close_price: position.current_price,
              pl: position.unrealized_pl,
              pl_percent: position.unrealized_plpc,
              order_id: closeOrder.id,
              reason: 'No bracket orders or sell orders found',
            } as any,
          },
        });
        
        // Wait 500ms between orders to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error: any) {
        logger.error(`❌ Failed to close ${position.symbol}: ${error.message}`);
        failedPositions.push({
          symbol: position.symbol,
          error: error.message,
        });
      }
    }
    
    // 6. Summary
    logger.log('\n' + '='.repeat(60));
    logger.log('📊 SUMMARY:');
    logger.log('='.repeat(60));
    logger.log(`Total positions checked: ${positions.length}`);
    logger.log(`Protected positions: ${positions.length - unprotectedPositions.length}`);
    logger.log(`Unprotected positions found: ${unprotectedPositions.length}`);
    logger.log(`Successfully closed: ${closedPositions.length}`);
    logger.log(`Failed to close: ${failedPositions.length}`);
    
    if (closedPositions.length > 0) {
      logger.log('\n✅ Closed positions:');
      closedPositions.forEach(symbol => logger.log(`   - ${symbol}`));
    }
    
    if (failedPositions.length > 0) {
      logger.warn('\n❌ Failed positions:');
      failedPositions.forEach(({ symbol, error }) => logger.warn(`   - ${symbol}: ${error}`));
    }
    
    logger.log('='.repeat(60) + '\n');
    
  } catch (error: any) {
    logger.error(`❌ Script failed: ${error.message}`);
    logger.error(error.stack);
  } finally {
    await app.close();
  }
}

bootstrap();
