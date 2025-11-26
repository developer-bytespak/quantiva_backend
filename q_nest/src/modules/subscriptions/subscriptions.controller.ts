import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('plans')
  findAllPlans() {
    return this.subscriptionsService.findAllPlans();
  }

  @Get('plans/:id')
  findPlan(@Param('id') id: string) {
    return this.subscriptionsService.findPlan(id);
  }

  @Post('plans')
  createPlan(@Body() createPlanDto: any) {
    return this.subscriptionsService.createPlan(createPlanDto);
  }

  @Put('plans/:id')
  updatePlan(@Param('id') id: string, @Body() updatePlanDto: any) {
    return this.subscriptionsService.updatePlan(id, updatePlanDto);
  }

  @Delete('plans/:id')
  removePlan(@Param('id') id: string) {
    return this.subscriptionsService.deletePlan(id);
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

  @Post()
  createSubscription(@Body() createSubscriptionDto: any) {
    return this.subscriptionsService.createSubscription(createSubscriptionDto);
  }

  @Put(':id')
  updateSubscription(@Param('id') id: string, @Body() updateSubscriptionDto: any) {
    return this.subscriptionsService.updateSubscription(id, updateSubscriptionDto);
  }

  @Delete(':id')
  removeSubscription(@Param('id') id: string) {
    return this.subscriptionsService.deleteSubscription(id);
  }
}

