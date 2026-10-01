import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

/**
 * User-facing subscription reads. Writes happen only through the billing
 * providers (Stripe / Apple controllers) and the super-admin tools; the old
 * unauthenticated update/subscribe/plan-admin endpoints were removed because
 * they allowed any caller to change tiers without paying.
 */
@Controller('/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  private requireUser(req: any): string {
    const userId = req.subscriptionUser?.user_id ?? req.userId;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return userId;
  }

  /** Current subscription, usage, payments, purchasable plans and trial eligibility. */
  @Get()
  getMySubscription(@Req() req: any) {
    return this.subscriptionsService.getMySubscription(this.requireUser(req));
  }

  /** Purchasable plans only (FREE + PREMIUM). Legacy plans are inactive and hidden. */
  @Get('plans')
  findAllPlans() {
    return this.subscriptionsService.findAllPlans(false);
  }

  @Get('usage/check/:featureType')
  async checkUsage(@Req() req: any, @Param('featureType') featureType: string) {
    const userId = this.requireUser(req);
    if (!featureType) {
      throw new BadRequestException('featureType is required');
    }
    return this.subscriptionsService.canUseFeature(userId, featureType as any);
  }

  @Post('usage/increment')
  async incrementUsage(@Req() req: any, @Body() body: { featureType: string }) {
    const userId = this.requireUser(req);
    if (!body?.featureType) {
      throw new BadRequestException('featureType is required');
    }
    await this.subscriptionsService.incrementUsage(userId, body.featureType as any);
    return { success: true, message: 'Usage incremented' };
  }
}
