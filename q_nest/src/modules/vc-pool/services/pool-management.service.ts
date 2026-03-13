import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreatePoolDto } from '../dto/create-pool.dto';
import { UpdatePoolDto } from '../dto/update-pool.dto';

const POOL_STATUS = {
  draft: 'draft',
  open: 'open',
  full: 'full',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
} as const;

@Injectable()
export class PoolManagementService {
  private readonly logger = new Logger(PoolManagementService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Admin: Create Draft Pool ──

  async createPool(adminId: string, dto: CreatePoolDto) {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: {
        admin_id: true,
        default_pool_fee_percent: true,
        default_admin_profit_fee_percent: true,
        default_cancellation_fee_percent: true,
        default_payment_window_minutes: true,
      },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    // Validate payment_window_minutes if provided
    if (dto.payment_window_minutes !== undefined) {
      if (dto.payment_window_minutes <= 0) {
        throw new BadRequestException('Payment window must be greater than 0 minutes');
      }
      if (dto.payment_window_minutes > 525600) {
        // Max 1 year
        throw new BadRequestException(
          'Payment window cannot exceed 525600 minutes (1 year)',
        );
      }
    }

    const pool = await this.prisma.vc_pools.create({
      data: {
        admin_id: adminId,
        name: dto.name,
        description: dto.description || null,
        coin_type: dto.coin_type || 'USDT',
        contribution_amount: dto.contribution_amount,
        max_members: dto.max_members,
        duration_days: dto.duration_days,
        pool_fee_percent:
          dto.pool_fee_percent ?? Number(admin.default_pool_fee_percent),
        admin_profit_fee_percent:
          dto.admin_profit_fee_percent ?? Number(admin.default_admin_profit_fee_percent),
        cancellation_fee_percent:
          dto.cancellation_fee_percent ?? Number(admin.default_cancellation_fee_percent),
        payment_window_minutes:
          dto.payment_window_minutes ?? admin.default_payment_window_minutes,
        status: POOL_STATUS.draft,
      },
    });

    this.logger.log(`Pool ${pool.pool_id} created as draft by admin ${adminId}`);
    return pool;
  }

  // ── Admin: Update Draft Pool ──

  async updatePool(adminId: string, poolId: string, dto: UpdatePoolDto) {
    const pool = await this.findPoolOrFail(poolId);

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    if (pool.status !== POOL_STATUS.draft) {
      throw new BadRequestException('Only draft pools can be edited');
    }

    // Validate payment_window_minutes if provided
    if (dto.payment_window_minutes !== undefined) {
      if (dto.payment_window_minutes <= 0) {
        throw new BadRequestException('Payment window must be greater than 0 minutes');
      }
      if (dto.payment_window_minutes > 525600) {
        // Max 1 year
        throw new BadRequestException(
          'Payment window cannot exceed 525600 minutes (1 year)',
        );
      }
    }

    const data: Record<string, any> = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.coin_type !== undefined) data.coin_type = dto.coin_type;
    if (dto.contribution_amount !== undefined)
      data.contribution_amount = dto.contribution_amount;
    if (dto.max_members !== undefined) data.max_members = dto.max_members;
    if (dto.duration_days !== undefined) data.duration_days = dto.duration_days;
    if (dto.pool_fee_percent !== undefined)
      data.pool_fee_percent = dto.pool_fee_percent;
    if (dto.admin_profit_fee_percent !== undefined)
      data.admin_profit_fee_percent = dto.admin_profit_fee_percent;
    if (dto.cancellation_fee_percent !== undefined)
      data.cancellation_fee_percent = dto.cancellation_fee_percent;
    if (dto.payment_window_minutes !== undefined)
      data.payment_window_minutes = dto.payment_window_minutes;

    return this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data,
    });
  }

  // ── Admin: Publish Pool (draft → open) ──

  async publishPool(adminId: string, poolId: string) {
    const pool = await this.findPoolOrFail(poolId);

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    if (pool.status !== POOL_STATUS.draft) {
      throw new BadRequestException('Only draft pools can be published');
    }

    if (
      !pool.name ||
      !pool.contribution_amount ||
      !pool.max_members ||
      !pool.duration_days
    ) {
      throw new BadRequestException(
        'Pool must have name, contribution_amount, max_members, and duration_days set before publishing',
      );
    }

    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: { binance_uid: true, wallet_address: true },
    });

    if (!admin?.wallet_address && !admin?.binance_uid) {
      throw new BadRequestException(
        'You must configure your wallet address (or Binance UID) in admin settings before publishing a pool',
      );
    }

    const updated = await this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data: { status: POOL_STATUS.open },
    });

    this.logger.log(`Pool ${poolId} published (draft → open) by admin ${adminId}`);
    return updated;
  }

  // ── Admin: Clone Pool ──

  async clonePool(adminId: string, poolId: string) {
    const source = await this.findPoolOrFail(poolId);

    if (source.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    const clone = await this.prisma.vc_pools.create({
      data: {
        admin_id: adminId,
        name: `${source.name} (Copy)`,
        description: source.description,
        coin_type: source.coin_type,
        contribution_amount: source.contribution_amount,
        max_members: source.max_members,
        duration_days: source.duration_days,
        pool_fee_percent: source.pool_fee_percent,
        admin_profit_fee_percent: source.admin_profit_fee_percent,
        cancellation_fee_percent: source.cancellation_fee_percent,
        payment_window_minutes: source.payment_window_minutes,
        is_replica: true,
        original_pool_id: source.pool_id,
        status: POOL_STATUS.draft,
      },
    });

    this.logger.log(
      `Pool ${clone.pool_id} cloned from ${poolId} by admin ${adminId}`,
    );
    return clone;
  }

  // ── Admin: Delete Pool (soft delete: draft only) ──

  async deletePool(adminId: string, poolId: string) {
    const pool = await this.findPoolOrFail(poolId);

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    if (pool.status !== POOL_STATUS.draft) {
      throw new BadRequestException('Only draft pools can be deleted');
    }

    await this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data: { is_archived: true, status: POOL_STATUS.cancelled },
    });

    this.logger.log(`Pool ${poolId} deleted (archived) by admin ${adminId}`);
    return { message: 'Pool deleted successfully' };
  }

  // ── Admin: List Pools ──

  async listAdminPools(
    adminId: string,
    filters: { status?: string; page?: number; limit?: number },
  ) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 50) : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = {
      admin_id: adminId,
      is_archived: false,
    };

    const validStatuses = Object.values(POOL_STATUS);
    if (filters.status && validStatuses.includes(filters.status as any)) {
      where.status = filters.status as any;
    }

    const [pools, total] = await this.prisma.$transaction([
      this.prisma.vc_pools.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          pool_id: true,
          name: true,
          status: true,
          coin_type: true,
          contribution_amount: true,
          max_members: true,
          verified_members_count: true,
          reserved_seats_count: true,
          duration_days: true,
          pool_fee_percent: true,
          is_replica: true,
          started_at: true,
          end_date: true,
          total_invested_usdt: true,
          current_pool_value_usdt: true,
          total_profit_usdt: true,
          created_at: true,
        },
      }),
      this.prisma.vc_pools.count({ where }),
    ]);

    return {
      pools,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ── Admin: Get Pool Details ──

  async getAdminPoolDetails(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      include: {
        _count: {
          select: {
            members: true,
            seat_reservations: true,
            trades: true,
          },
        },
      },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    return pool;
  }

  // ── User: Browse Available Pools ──

  async getAvailablePools(query: { page?: number; limit?: number }) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = {
      status: POOL_STATUS.open,
      is_archived: false,
    };

    const [pools, total] = await this.prisma.$transaction([
      this.prisma.vc_pools.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          pool_id: true,
          name: true,
          description: true,
          coin_type: true,
          contribution_amount: true,
          max_members: true,
          verified_members_count: true,
          reserved_seats_count: true,
          duration_days: true,
          pool_fee_percent: true,
          payment_window_minutes: true,
          created_at: true,
          admin: {
            select: { binance_uid: true, wallet_address: true, payment_network: true },
          },
        },
      }),
      this.prisma.vc_pools.count({ where }),
    ]);

    const mapped = pools.map((p) => ({
      pool_id: p.pool_id,
      name: p.name,
      description: p.description,
      coin_type: p.coin_type,
      contribution_amount: p.contribution_amount,
      max_members: p.max_members,
      available_seats:
        p.max_members - p.reserved_seats_count - p.verified_members_count,
      duration_days: p.duration_days,
      pool_fee_percent: p.pool_fee_percent,
      payment_window_minutes: p.payment_window_minutes,
      admin_binance_uid: p.admin?.binance_uid || null,
      admin_wallet_address: p.admin?.wallet_address || null,
      payment_network: p.admin?.payment_network || 'BSC',
      deposit_coin: 'USDT',
      deposit_method: 'on_chain',
      created_at: p.created_at,
    }));

    return {
      pools: mapped,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ── User: Get Pool Details ──

  async getPoolForUser(poolId: string, userId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: {
        pool_id: true,
        name: true,
        description: true,
        coin_type: true,
        contribution_amount: true,
        max_members: true,
        verified_members_count: true,
        reserved_seats_count: true,
        duration_days: true,
        pool_fee_percent: true,
        admin_profit_fee_percent: true,
        cancellation_fee_percent: true,
        payment_window_minutes: true,
        status: true,
        started_at: true,
        end_date: true,
        completed_at: true,
        created_at: true,
        current_pool_value_usdt: true,
        total_invested_usdt: true,
        total_profit_usdt: true,
        total_pool_fees_usdt: true,
        admin_id: true,
        admin: {
          select: { binance_uid: true, wallet_address: true, payment_network: true },
        },
      },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    if (pool.status === POOL_STATUS.draft) {
      throw new NotFoundException('Pool not found');
    }

    // Fetch user's membership in this pool (if any)
    const membership = await this.prisma.vc_pool_members.findUnique({
      where: {
        pool_id_user_id: { pool_id: poolId, user_id: userId },
      },
      select: {
        member_id: true,
        invested_amount_usdt: true,
        share_percent: true,
        joined_at: true,
        exited_at: true,
        is_active: true,
        payment_method: true,
      },
    });

    // Calculate user metrics if they're a member
    let userMetrics: any = null;
    if (membership) {
      const sharePercent = Number(membership.share_percent || 0);
      const investedAmount = Number(membership.invested_amount_usdt);
      const poolValue = Number(pool.current_pool_value_usdt || pool.total_invested_usdt || 0);
      const currentValue = (sharePercent * poolValue) / 100;
      const profitLoss = currentValue - investedAmount;
      const profitLossPct = investedAmount > 0 ? (profitLoss / investedAmount) * 100 : 0;

      userMetrics = {
        is_member: true,
        member_id: membership.member_id,
        invested_amount_usdt: investedAmount,
        current_share_percent: sharePercent,
        joined_at: membership.joined_at,
        exited_at: membership.exited_at,
        is_active: membership.is_active,
        payment_method: membership.payment_method,
        current_member_value_usdt: currentValue,
        unrealized_pnl_usdt: profitLoss,
        unrealized_pnl_pct: profitLossPct,
      };
    } else {
      userMetrics = {
        is_member: false,
        member_id: null,
        invested_amount_usdt: 0,
        current_share_percent: 0,
        joined_at: null,
        exited_at: null,
        is_active: false,
        payment_method: null,
        current_member_value_usdt: 0,
        unrealized_pnl_usdt: 0,
        unrealized_pnl_pct: 0,
      };
    }

    // Calculate pool progress
    const daysTotal = pool.duration_days;
    const startDate = pool.started_at ? new Date(pool.started_at) : new Date(pool.created_at);
    const endDate = pool.end_date ? new Date(pool.end_date) : new Date(startDate.getTime() + daysTotal * 24 * 60 * 60 * 1000);
    const now = new Date();
    const totalMs = endDate.getTime() - startDate.getTime();
    const elapsedMs = now.getTime() - startDate.getTime();
    const progressPct = Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100));
    const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    // Calculate pool ROI
    const totalInvested = Number(pool.total_invested_usdt || 0);
    const poolROI = totalInvested > 0 ? ((Number(pool.current_pool_value_usdt || 0) - totalInvested) / totalInvested) * 100 : 0;

    return {
      // Pool Metadata
      pool_metadata: {
        pool_id: pool.pool_id,
        name: pool.name,
        description: pool.description,
        coin_type: pool.coin_type,
        status: pool.status,
        created_at: pool.created_at,
      },

      // Pool Details
      pool_details: {
        contribution_amount: Number(pool.contribution_amount),
        max_members: pool.max_members,
        verified_members_count: pool.verified_members_count,
        reserved_seats_count: pool.reserved_seats_count,
        available_seats: pool.max_members - pool.reserved_seats_count - pool.verified_members_count,
        duration_days: pool.duration_days,
        pool_fee_percent: Number(pool.pool_fee_percent || 0),
        admin_profit_fee_percent: Number(pool.admin_profit_fee_percent || 0),
        cancellation_fee_percent: Number(pool.cancellation_fee_percent || 0),
        payment_window_minutes: pool.payment_window_minutes,
      },

      // Pool Financials
      pool_financials: {
        total_invested_usdt: Number(pool.total_invested_usdt || 0),
        current_pool_value_usdt: Number(pool.current_pool_value_usdt || 0),
        total_profit_usdt: Number(pool.total_profit_usdt || 0),
        total_pool_fees_usdt: Number(pool.total_pool_fees_usdt || 0),
        pool_roi_pct: poolROI,
      },

      // Admin Info
      admin_info: {
        binance_uid: pool.admin?.binance_uid || null,
        wallet_address: pool.admin?.wallet_address || null,
        payment_network: pool.admin?.payment_network || 'BSC',
        deposit_coin: 'USDT',
        deposit_method: 'on_chain',
      },

      // User's Membership & Performance
      user_context: userMetrics,

      // Pool Timeline
      pool_timeline: {
        started_at: pool.started_at,
        end_date: pool.end_date,
        completed_at: pool.completed_at,
        days_remaining: daysRemaining,
        progress_percent: Math.round(progressPct * 100) / 100,
      },
    };
  }

  // ── Admin: Start Pool (full → active) ──

  async startPool(adminId: string, poolId: string) {
    const pool = await this.findPoolOrFail(poolId);

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    if (pool.status !== POOL_STATUS.full) {
      throw new BadRequestException('Only full pools can be started');
    }

    if (pool.verified_members_count < pool.max_members) {
      throw new BadRequestException('Pool does not have all members verified yet');
    }

    const members = await this.prisma.vc_pool_members.findMany({
      where: { pool_id: poolId, is_active: true },
      select: { member_id: true, invested_amount_usdt: true },
    });

    const totalInvested = members.reduce(
      (sum, m) => sum + Number(m.invested_amount_usdt),
      0,
    );

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + pool.duration_days);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Calculate and set share_percent for each member
      for (const member of members) {
        const share = (Number(member.invested_amount_usdt) / totalInvested) * 100;
        await tx.vc_pool_members.update({
          where: { member_id: member.member_id },
          data: { share_percent: share },
        });
      }

      return tx.vc_pools.update({
        where: { pool_id: poolId },
        data: {
          status: POOL_STATUS.active as any,
          started_at: new Date(),
          end_date: endDate,
          total_invested_usdt: totalInvested,
          current_pool_value_usdt: totalInvested,
          total_profit_usdt: 0,
        },
      });
    });

    this.logger.log(`Pool ${poolId} started (full → active) by admin ${adminId}`);
    return updated;
  }

  // ── Helpers ──

  private async findPoolOrFail(poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    return pool;
  }
}
