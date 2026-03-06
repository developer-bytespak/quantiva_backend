import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from 'src/firebase/firebase.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, FirebaseService, PrismaService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

