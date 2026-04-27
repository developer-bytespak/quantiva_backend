import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  UpdateBinanceSettingsDto,
  UpdateFeeSettingsDto,
} from '../dto/update-admin-settings.dto';
import { AdminBinanceService } from './admin-binance.service';

@Injectable()
export class AdminSettingsService {
  private readonly logger = new Logger(AdminSettingsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly adminBinanceService: AdminBinanceService,
  ) {}

  async getSettings(adminId: string) {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        binance_uid: true,
        wallet_address: true,
        payment_network: true,
        default_pool_fee_percent: true,
        default_admin_profit_fee_percent: true,
        default_cancellation_fee_percent: true,
        default_payment_window_minutes: true,
        created_at: true,
      },
    });

    if (!admin) throw new NotFoundException('Admin not found');

    // Best-effort: include the admin's connected Binance variant so the settings UI
    // can show "Connected to: Binance" or "Connected to: Binance.US".
    let connected_exchange_name: string | null = null;
    try {
      connected_exchange_name = await this.adminBinanceService.getAdminExchangeName(adminId);
    } catch (err: any) {
      this.logger.debug(
        `Admin ${adminId} has no active Binance connection: ${err.message}`,
      );
    }

    return { ...admin, connected_exchange_name };
  }

  async updateBinanceSettings(
    adminId: string,
    dto: UpdateBinanceSettingsDto,
  ) {
    const updateData: any = {};
    if (dto.binance_uid !== undefined) updateData.binance_uid = dto.binance_uid;
    if (dto.wallet_address !== undefined) updateData.wallet_address = dto.wallet_address;
    if (dto.payment_network !== undefined) updateData.payment_network = dto.payment_network;

    const admin = await this.prisma.admins.update({
      where: { admin_id: adminId },
      data: updateData,
      select: {
        admin_id: true,
        binance_uid: true,
        wallet_address: true,
        payment_network: true,
      },
    });

    return {
      message: 'Binance settings updated',
      binance_uid: admin.binance_uid,
      wallet_address: admin.wallet_address,
      payment_network: admin.payment_network,
    };
  }

  async updateFeeSettings(adminId: string, dto: UpdateFeeSettingsDto, isSuperAdmin?: boolean) {
    if (!isSuperAdmin) {
      throw new ForbiddenException('Only super admin can update default fee settings');
    }

    const admin = await this.prisma.admins.update({
      where: { admin_id: adminId },
      data: {
        default_pool_fee_percent: dto.default_pool_fee_percent,
        default_admin_profit_fee_percent: dto.default_admin_profit_fee_percent,
        default_cancellation_fee_percent: dto.default_cancellation_fee_percent,
        default_payment_window_minutes: dto.default_payment_window_minutes,
      },
      select: {
        admin_id: true,
        default_pool_fee_percent: true,
        default_admin_profit_fee_percent: true,
        default_cancellation_fee_percent: true,
        default_payment_window_minutes: true,
      },
    });

    return {
      message: 'Fee settings updated',
      ...admin,
    };
  }
}
