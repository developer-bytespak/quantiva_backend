import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class KycVerifiedGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      throw new ForbiddenException('User not authenticated');
    }

    const userRecord = await this.prisma.users.findUnique({
      where: { user_id: user.sub },
      select: { kyc_status: true },
    });

    if (!userRecord) {
      throw new ForbiddenException('User not found');
    }

    if (userRecord.kyc_status !== 'approved') {
      throw new ForbiddenException(
        `KYC verification required. Current status: ${userRecord.kyc_status}`,
      );
    }

    return true;
  }
}
