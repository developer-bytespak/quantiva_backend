import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class USComplianceGuard implements CanActivate {
  private readonly logger = new Logger(USComplianceGuard.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Normalizes nationality string to check if user is US national
   */
  private isUSNational(nationality: string | null): boolean {
    if (!nationality) return false;
    
    const normalized = nationality.toLowerCase().trim();
    const usVariants = ['us', 'usa', 'united states', 'united states of america'];
    
    return usVariants.includes(normalized);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub || request.user?.user_id;

    if (!userId) {
      // If no user in request, let other guards handle auth
      return true;
    }

    // Fetch user from database
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { nationality: true },
    });

    if (!user) {
      this.logger.warn(`User ${userId} not found during compliance check`);
      return true; // Let request proceed, other guards will handle
    }

    const isUS = this.isUSNational(user.nationality);

    // Check if trying to access Binance (not Binance.US)
    const exchangeName = 
      request.body?.exchange_name || 
      request.body?.exchangeName ||
      request.params?.exchangeName ||
      request.query?.exchange;

    if (exchangeName) {
      const normalized = exchangeName.toLowerCase().trim();

      // US nationals cannot use Binance (must use Binance.US)
      if (isUS && normalized === 'binance') {
        this.logger.warn(
          `US national ${userId} attempted to access Binance. Blocking request.`
        );
        throw new ForbiddenException(
          'Binance is not available for US nationals. Please use Binance.US instead.'
        );
      }

      // Non-US nationals cannot use Binance.US (must use Binance)
      if (!isUS && (normalized === 'binance.us' || normalized === 'binanceus')) {
        this.logger.warn(
          `Non-US user ${userId} attempted to access Binance.US. Blocking request.`
        );
        throw new ForbiddenException(
          'Binance.US is only available for US residents. Please use Binance instead.'
        );
      }
    }

    return true;
  }
}
