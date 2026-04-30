import { Controller, Get, Post, Put, Delete, Body, Param, Query, Req, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { PrismaService } from '../../prisma/prisma.service';


@Controller('/subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly prisma: PrismaService,
  ) { }

  @Get('usage/check/:featureType')
  async checkUsage(
    @Param('featureType') featureType: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    
    return this.subscriptionsService.canUseFeature(
      userId, 
      featureType as any
    );
  }

  // ✅ NEW: Increment usage when feature is used
  @Post('usage/increment')
  async incrementUsage(@Body() body: { userId: string; featureType: string }) {
    if (!body.userId || !body.featureType) {
      throw new BadRequestException('userId and featureType are required');
    }
    
    await this.subscriptionsService.incrementUsage(
      body.userId,
      body.featureType as any
    );
    
    return { success: true, message: 'Usage incremented' };
  }

  @Put('update')
  async updateSubscription(@Req() req:any, @Body() updateSubscriptionDto: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    // Query DB directly instead of relying on cached tier
    const active = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
    });

    if (!active) {
      throw new BadRequestException('Subscription ID is required to update subscription');
    }

    // User must cancel current paid subscription before updating
    if (active.tier !== 'FREE') {
      throw new BadRequestException(
        'Cancel your current subscription.',
      );
    }

    return this.subscriptionsService.updateSubscription(active.subscription_id, updateSubscriptionDto);
  }

  @Post('plans')
  createPlan(@Body() createPlanDto: any) {
    return this.subscriptionsService.createPlan(createPlanDto);
  }
  @Get('plans')
  findAllPlans() {
    return this.subscriptionsService.findAllPlans();
  }

  @Get('plans/:id')
  findPlan(@Param('id') id: string) {
    return this.subscriptionsService.findPlan(id);
  }


  @Put('plans/:id')
  updatePlan(@Param('id') id: string, @Body() updatePlanDto: any) {
    // return this.subscriptionsService.updatePlan(id, updatePlanDto);
  }

  @Delete('plans/:id')
  removePlan(@Param('id') id: string) {
    // return this.subscriptionsService.deletePlan(id);
  }

  @Get()
  getMySubscription(@Req() req: any) {
    const user_id = req.userId;
    return this.subscriptionsService.getMySubscription(user_id);
  }

  @Get('list')
  findAllSubscriptions(@Query('userId') userId?: string) {
    if (userId) {
      return this.subscriptionsService.findByUser(userId);
    }
    return this.subscriptionsService.findAllSubscriptions();
  }

  @Get(':id')
  findSubscription(@Param('id') id: string) {
    return this.subscriptionsService.findSubscription(id);
  }

  @Post("subscribe")
  createSubscription(@Body() createSubscriptionDto: any, @Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    createSubscriptionDto.user_id = userId;
    return this.subscriptionsService.createSubscriptionUser(createSubscriptionDto);
  }

 

  @Delete(':id')
  removeSubscription(@Param('id') id: string) {
    return this.subscriptionsService.deleteSubscription(id);
  }

 
}

