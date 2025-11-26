import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async findAllPlans() {
    return this.prisma.subscription_plans.findMany();
  }

  async findPlan(id: string) {
    return this.prisma.subscription_plans.findUnique({
      where: { plan_id: id },
      include: { user_subscriptions: true },
    });
  }

  async createPlan(data: {
    name: string;
    price_monthly?: number;
    description?: string;
    features_json?: any;
  }) {
    return this.prisma.subscription_plans.create({
      data,
    });
  }

  async updatePlan(id: string, data: {
    name?: string;
    price_monthly?: number;
    description?: string;
    features_json?: any;
  }) {
    return this.prisma.subscription_plans.update({
      where: { plan_id: id },
      data,
    });
  }

  async deletePlan(id: string) {
    return this.prisma.subscription_plans.delete({
      where: { plan_id: id },
    });
  }

  async findAllSubscriptions() {
    return this.prisma.user_subscriptions.findMany({
      include: {
        user: true,
        plan: true,
      },
    });
  }

  async findSubscription(id: string) {
    return this.prisma.user_subscriptions.findUnique({
      where: { subscription_id: id },
      include: {
        user: true,
        plan: true,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.user_subscriptions.findMany({
      where: { user_id: userId },
      include: {
        plan: true,
      },
    });
  }

  async createSubscription(data: {
    user_id: string;
    plan_id: string;
    status?: string;
    started_at?: Date;
    expires_at?: Date;
    billing_provider?: string;
  }) {
    return this.prisma.user_subscriptions.create({
      data,
      include: {
        user: true,
        plan: true,
      },
    });
  }

  async updateSubscription(id: string, data: {
    status?: string;
    expires_at?: Date;
    billing_provider?: string;
  }) {
    return this.prisma.user_subscriptions.update({
      where: { subscription_id: id },
      data,
    });
  }

  async deleteSubscription(id: string) {
    return this.prisma.user_subscriptions.delete({
      where: { subscription_id: id },
    });
  }
}

