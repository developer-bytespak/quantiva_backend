import { Module } from '@nestjs/common';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { KycModule } from '../../kyc/kyc.module';

@Module({
  imports: [KycModule], // Provides PythonApiService
  controllers: [NewsController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}

