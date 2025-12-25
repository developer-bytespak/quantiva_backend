import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TaskSchedulerService } from './task-scheduler.service';
import { TaskSchedulerController } from './task-scheduler.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [TaskSchedulerService],
  controllers: [TaskSchedulerController],
  exports: [TaskSchedulerService],
})
export class TaskSchedulerModule {}
