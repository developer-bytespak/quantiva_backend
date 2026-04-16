import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = new URL(process.env.DATABASE_URL);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '15');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '30');
    }
    super({
      datasources: {
        db: { url: url.toString() },
      },
    });
  }

  async onModuleInit() {
    const maxRetries = 5;
    const baseDelay = 2000; // 2 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Database connected successfully');
        return;
      } catch (error: any) {
        if (attempt === maxRetries) {
          this.logger.error(`Failed to connect to database after ${maxRetries} attempts: ${error.message}`);
          throw error;
        }
        const delay = baseDelay * attempt;
        this.logger.warn(`Database connection attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

