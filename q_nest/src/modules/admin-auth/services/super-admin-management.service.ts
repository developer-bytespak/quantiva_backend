import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import sgMail from '@sendgrid/mail';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SuperAdminListUsersDto } from '../dto/super-admin-list-users.dto';
import { CreateVcPoolAdminDto } from '../dto/create-vc-pool-admin.dto';
import { SuperAdminUsersGrowthDto } from '../dto/super-admin-users-growth.dto';

@Injectable()
export class SuperAdminManagementService {
  private readonly logger = new Logger(SuperAdminManagementService.name);

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.SENDGRID_API_KEY;

    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  private readonly monthLabels = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  private async verifySuperAdminPassword(
    superAdminId: string,
    currentPassword: string,
  ): Promise<void> {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { password_hash: true, is_super_admin: true },
    });

    if (!admin || !admin.is_super_admin) {
      throw new UnauthorizedException('Super admin not found');
    }

    const isValid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid current password');
    }
  }

  async listUsers(query: SuperAdminListUsersDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      ...(query.plan ? { current_tier: query.plan } : {}),
      ...(query.kyc_status ? { kyc_status: query.kyc_status } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { username: { contains: query.search, mode: 'insensitive' } },
              { full_name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.subscription_status
        ? {
            subscriptions: {
              some: {
                status: query.subscription_status as SubscriptionStatus,
              },
            },
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      this.prisma.users.count({ where }),
      this.prisma.users.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          user_id: true,
          email: true,
          username: true,
          full_name: true,
          current_tier: true,
          kyc_status: true,
          created_at: true,
          sessions: {
            where: { revoked: false },
            orderBy: { issued_at: 'desc' },
            take: 1,
            select: { issued_at: true },
          },
          subscriptions: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: {
              status: true,
              tier: true,
              billing_period: true,
              current_period_end: true,
            },
          },
          pool_memberships: {
            where: { is_active: true },
            select: {
              invested_amount_usdt: true,
            },
          },
        },
      }),
    ]);

    return {
      users: users.map((user) => {
        const latestSubscription = user.subscriptions[0] ?? null;
        const lastSession = user.sessions[0] ?? null;
        const totalInvested = user.pool_memberships.reduce((sum, m) => {
          const value = Number(m.invested_amount_usdt ?? 0);
          if (!Number.isFinite(value)) return sum;
          return sum + value;
        }, 0);

        return {
          user_id: user.user_id,
          email: user.email,
          username: user.username,
          full_name: user.full_name,
          current_tier: user.current_tier,
          kyc_status: user.kyc_status,
          created_at: user.created_at,
          last_active_at: lastSession?.issued_at ?? null,
          subscription_status: latestSubscription?.status ?? null,
          subscription_plan: latestSubscription?.tier ?? null,
          billing_period: latestSubscription?.billing_period ?? null,
          subscription_period_end: latestSubscription?.current_period_end ?? null,
          total_invested_usdt: Number(totalInvested.toFixed(2)),
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async usersAnalytics() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeLast30Days,
      paidUsers,
      freeUsers,
      planDistribution,
      recentSignups,
      cryptoConnections,
      stockConnections,
      activeConnections,
      pendingConnections,
      recentSyncedUsers,
    ] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.users.count({
        where: {
          sessions: {
            some: {
              issued_at: { gte: thirtyDaysAgo },
              revoked: false,
            },
          },
        },
      }),
      this.prisma.users.count({ where: { current_tier: { in: ['PRO', 'ELITE'] } } }),
      this.prisma.users.count({ where: { current_tier: 'FREE' } }),
      this.prisma.users.groupBy({
        by: ['current_tier'],
        _count: { current_tier: true },
      }),
      this.prisma.users.findMany({
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          user_id: true,
          email: true,
          full_name: true,
          current_tier: true,
          created_at: true,
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          exchange: {
            type: 'crypto',
          },
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          exchange: {
            type: 'stocks',
          },
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          status: 'active',
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          status: 'pending',
        },
      }),
      this.prisma.user_exchange_connections.findMany({
        where: {
          last_synced_at: {
            not: null,
          },
        },
        orderBy: { last_synced_at: 'desc' },
        take: 5,
        select: {
          connection_id: true,
          status: true,
          last_synced_at: true,
          exchange: {
            select: {
              name: true,
              type: true,
            },
          },
          user: {
            select: {
              user_id: true,
              email: true,
              full_name: true,
            },
          },
        },
      }),
    ]);

    const distributionMap: Record<string, number> = {
      FREE: 0,
      PRO: 0,
      ELITE: 0,
    };

    for (const item of planDistribution) {
      distributionMap[item.current_tier] = item._count.current_tier;
    }

    return {
      summary: {
        total_users: totalUsers,
        active_last_30_days: activeLast30Days,
        paid_users: paidUsers,
        free_users: freeUsers,
      },
      plan_distribution: distributionMap,
      recent_signups: recentSignups,
      exchange_connections: {
        crypto_connections: cryptoConnections,
        stock_connections: stockConnections,
        active_connections: activeConnections,
        pending_connections: pendingConnections,
        recent_synced_users: recentSyncedUsers.map((item) => ({
          connection_id: item.connection_id,
          status: item.status,
          last_synced_at: item.last_synced_at,
          exchange_name: item.exchange.name,
          exchange_type: item.exchange.type,
          user_id: item.user.user_id,
          email: item.user.email,
          full_name: item.user.full_name,
        })),
      },
    };
  }

  async usersGrowthByMonth(query: SuperAdminUsersGrowthDto) {
    const now = new Date();
    const year = query.year ?? now.getFullYear();

    const yearStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));

    const activeCutoff = new Date();
    activeCutoff.setDate(activeCutoff.getDate() - 30);

    const where = {
      created_at: {
        gte: yearStart,
        lt: yearEnd,
      },
      ...(query.subscription_plan
        ? {
            current_tier: query.subscription_plan,
          }
        : {}),
      ...(query.active_only
        ? {
            sessions: {
              some: {
                revoked: false,
                issued_at: { gte: activeCutoff },
              },
            },
          }
        : {}),
    };

    const [users, firstUser] = await Promise.all([
      this.prisma.users.findMany({
        where,
        select: { created_at: true },
      }),
      this.prisma.users.findFirst({
        select: { created_at: true },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    const monthCounts = new Array(12).fill(0) as number[];
    for (const user of users) {
      const monthIndex = new Date(user.created_at).getUTCMonth();
      if (monthIndex >= 0 && monthIndex < 12) {
        monthCounts[monthIndex] += 1;
      }
    }

    let cumulative = 0;
    const monthly = monthCounts.map((count, index) => {
      cumulative += count;
      return {
        month: index + 1,
        label: this.monthLabels[index],
        users: count,
        cumulative_users: cumulative,
      };
    });

    const startYear = firstUser
      ? new Date(firstUser.created_at).getUTCFullYear()
      : now.getFullYear();
    const available_years: number[] = [];
    for (let y = now.getFullYear(); y >= startYear; y -= 1) {
      available_years.push(y);
    }

    return {
      year,
      filters: {
        subscription_plan: query.subscription_plan ?? 'ALL',
        active_only: !!query.active_only,
      },
      total_users: users.length,
      monthly,
      available_years,
    };
  }

  async listVcPoolAdmins() {
    const admins = await this.prisma.admins.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        created_at: true,
        _count: {
          select: {
            pools: {
              where: {
                is_archived: false,
              },
            },
          },
        },
      },
    });

    return {
      admins: admins.map((admin) => ({
        admin_id: admin.admin_id,
        email: admin.email,
        full_name: admin.full_name,
        is_super_admin: admin.is_super_admin,
        created_at: admin.created_at,
        active_pools_count: admin._count.pools,
      })),
    };
  }

  async createVcPoolAdmin(superAdminId: string, dto: CreateVcPoolAdminDto) {
    await this.verifySuperAdminPassword(superAdminId, dto.currentPassword);

    const normalizedEmail = dto.email.toLowerCase().trim();

    const exists = await this.prisma.admins.findUnique({
      where: { email: normalizedEmail },
      select: { admin_id: true },
    });

    if (exists) {
      throw new BadRequestException('Admin with this email already exists');
    }

    const superAdmin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { full_name: true, email: true },
    });

    const password_hash = await bcrypt.hash(dto.password, 10);

    const created = await this.prisma.admins.create({
      data: {
        email: normalizedEmail,
        password_hash,
        full_name: dto.full_name?.trim() || null,
        is_super_admin: dto.is_super_admin ?? false,
      },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        created_at: true,
      },
    });

    const frontendBaseUrl = (process.env.FRONTEND_URL || '').trim();
    const loginUrl = frontendBaseUrl
      ? `${frontendBaseUrl.replace(/\/$/, '')}/admin`
      : '/admin';
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
    const senderName = superAdmin?.full_name?.trim() || 'Quantiva Super Admin';

    if (!fromEmail) {
      await this.prisma.admins.delete({ where: { admin_id: created.admin_id } });
      throw new BadRequestException('Email service is not configured');
    }

    try {
      await sgMail.send({
        to: created.email,
        from: {
          email: fromEmail,
          name: senderName,
        },
        subject: 'Your Quantiva VC Pool Admin Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
            </div>
            <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">Your VC Pool Admin Account Is Ready</h2>
              <p style="color: #666; font-size: 16px;">Hello${created.full_name ? ` ${created.full_name}` : ''},</p>
              <p style="color: #666; font-size: 16px;">
                ${senderName} has created your Quantiva VC Pool Admin account.
              </p>
              <div style="background: #f8f8f8; border: 1px solid #ececec; border-radius: 8px; padding: 18px; margin: 20px 0;">
                <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${created.email}</p>
                <p style="margin: 0; color: #333;"><strong>Password:</strong> ${dto.password}</p>
              </div>
              <p style="color: #666; font-size: 16px;">Admin login link:</p>
              <p style="margin: 16px 0;">
                <a href="${loginUrl}" style="display: inline-block; background: #fc4f02; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 700;">Open Admin Login</a>
              </p>
              <p style="color: #999; font-size: 12px; margin-top: 30px;">For security, please sign in and change your password as soon as possible.</p>
            </div>
          </div>
        `,
      });
    } catch (error) {
      await this.prisma.admins.delete({ where: { admin_id: created.admin_id } });

      this.logger.error('Failed to send VC pool admin credentials email', {
        email: created.email,
        superAdminId,
        superAdminEmail: superAdmin?.email,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new BadRequestException(
        'Failed to send admin credentials email. Admin was not created.',
      );
    }

    return {
      message: 'VC pool admin created successfully',
      admin: created,
    };
  }

  async deleteVcPoolAdmin(
    superAdminId: string,
    targetAdminId: string,
    currentPassword: string,
  ) {
    await this.verifySuperAdminPassword(superAdminId, currentPassword);

    const superAdmin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { full_name: true, email: true },
    });

    if (superAdminId === targetAdminId) {
      throw new BadRequestException('You cannot delete your own admin account');
    }

    const target = await this.prisma.admins.findUnique({
      where: { admin_id: targetAdminId },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        _count: {
          select: {
            pools: {
              where: {
                is_archived: false,
              },
            },
          },
        },
      },
    });

    if (!target) {
      throw new NotFoundException('Target admin not found');
    }

    if (target.is_super_admin) {
      throw new BadRequestException('Super admin cannot be deleted from this action');
    }

    if (target._count.pools > 0) {
      throw new BadRequestException(
        'Cannot delete admin with active pools. Reassign/archive pools first.',
      );
    }

    await this.prisma.admins.delete({ where: { admin_id: targetAdminId } });

    const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
    const senderName = superAdmin?.full_name?.trim() || 'Quantiva Super Admin';

    if (fromEmail) {
      try {
        await sgMail.send({
          to: target.email,
          from: {
            email: fromEmail,
            name: senderName,
          },
          subject: 'Your Quantiva VC Pool Admin Account Has Been Removed',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
              </div>
              <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <h2 style="color: #333; margin-top: 0;">VC Pool Admin Account Removed</h2>
                <p style="color: #666; font-size: 16px;">Hello${target.full_name ? ` ${target.full_name}` : ''},</p>
                <p style="color: #666; font-size: 16px;">
                  ${senderName} has removed your Quantiva VC Pool Admin account.
                </p>
                <p style="color: #666; font-size: 16px; margin-top: 18px;">
                  If you believe this was done in error, please contact the Quantiva super admin team.
                </p>
                <p style="color: #999; font-size: 12px; margin-top: 30px;">This is an automated notification from Quantiva.</p>
              </div>
            </div>
          `,
        });
      } catch (error) {
        this.logger.error('Failed to send VC pool admin deletion email', {
          email: target.email,
          superAdminId,
          superAdminEmail: superAdmin?.email,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      message: 'VC pool admin deleted successfully',
      admin_id: targetAdminId,
      email: target.email,
    };
  }
}
