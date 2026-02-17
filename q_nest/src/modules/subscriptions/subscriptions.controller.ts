import { Controller, Get, Post, Put, Delete, Body, Param, Query, Req, BadRequestException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { BadRequest } from 'ccxt';


@Controller('/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) { }

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
  updateSubscription(@Req() req:any, @Body() updateSubscriptionDto: any) {
    const id =  req.subscriptionUser?.subscription_id;
    // return {
    //   message: `chala hy updated successfully `,
    //   subscriptionId: id,
    //   updateData: updateSubscriptionDto,
    // }
    if(!id) {
      throw new BadRequestException('Subscription ID is required to update subscription');
    }
    
    return this.subscriptionsService.updateSubscription(id, updateSubscriptionDto);
  }

  @Post('plans')
  createPlan(@Body() createPlanDto: any) {
    return this.subscriptionsService.createPlan(createPlanDto);
  }
  @Get('dashboard')
  async getDashboard(@Query('userId') userId?: string) {
    
    return this.subscriptionsService.getDashboard(userId);
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
  createSubscription(@Body() createSubscriptionDto: any) {
    return this.subscriptionsService.createSubscription(createSubscriptionDto);
  }

 

  @Delete(':id')
  removeSubscription(@Param('id') id: string) {
    return this.subscriptionsService.deleteSubscription(id);
  }

 
}

