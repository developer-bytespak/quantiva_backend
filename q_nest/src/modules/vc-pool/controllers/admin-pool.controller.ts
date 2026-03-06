import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PoolManagementService } from '../services/pool-management.service';
import { PoolCancellationService } from '../services/pool-cancellation.service';
import { PoolPayoutService } from '../services/pool-payout.service';
import { VcPoolTransactionsAdminService } from '../services/vc-pool-transactions-admin.service';
import { AdminJwtAuthGuard } from '../../admin-auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../admin-auth/decorators/current-admin.decorator';
import { AdminTokenPayload } from '../../admin-auth/services/admin-token.service';
import { CreatePoolDto } from '../dto/create-pool.dto';
import { UpdatePoolDto } from '../dto/update-pool.dto';
import { RejectCancellationDto } from '../dto/reject-cancellation.dto';
import { MarkRefundedDto } from '../dto/mark-refunded.dto';

@Controller('admin/pools')
@UseGuards(AdminJwtAuthGuard)
export class AdminPoolController {
  constructor(
    private readonly poolService: PoolManagementService,
    private readonly cancellationService: PoolCancellationService,
    private readonly payoutService: PoolPayoutService,
    private readonly transactionsService: VcPoolTransactionsAdminService,
  ) {}

  @Post()
  async createPool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: CreatePoolDto,
  ) {
    return this.poolService.createPool(admin.sub, dto);
  }

  @Get()
  async listPools(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.poolService.listAdminPools(admin.sub, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  async getPool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.poolService.getAdminPoolDetails(admin.sub, id);
  }

  @Put(':id')
  async updatePool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePoolDto,
  ) {
    return this.poolService.updatePool(admin.sub, id, dto);
  }

  @Put(':id/publish')
  async publishPool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.poolService.publishPool(admin.sub, id);
  }

  @Post(':id/clone')
  async clonePool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.poolService.clonePool(admin.sub, id);
  }

  @Put(':id/start')
  async startPool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.poolService.startPool(admin.sub, id);
  }

  @Delete(':id')
  async deletePool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.poolService.deletePool(admin.sub, id);
  }

  @Get(':id/cancellations')
  async listCancellations(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cancellationService.listCancellations(admin.sub, id);
  }

  @Put(':id/cancellations/:cid/approve')
  async approveCancellation(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) poolId: string,
    @Param('cid', ParseUUIDPipe) cancellationId: string,
  ) {
    return this.cancellationService.approveCancellation(admin.sub, poolId, cancellationId);
  }

  @Put(':id/cancellations/:cid/reject')
  async rejectCancellation(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) poolId: string,
    @Param('cid', ParseUUIDPipe) cancellationId: string,
    @Body() dto: RejectCancellationDto,
  ) {
    return this.cancellationService.rejectCancellation(
      admin.sub,
      poolId,
      cancellationId,
      dto.rejection_reason,
    );
  }

  @Put(':id/cancellations/:cid/mark-refunded')
  async markRefunded(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) poolId: string,
    @Param('cid', ParseUUIDPipe) cancellationId: string,
    @Body() dto: MarkRefundedDto,
  ) {
    return this.cancellationService.markRefunded(
      admin.sub,
      poolId,
      cancellationId,
      dto.binance_tx_id,
      dto.notes,
    );
  }

  @Put(':id/complete')
  async completePool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payoutService.completePool(admin.sub, id);
  }

  @Get(':id/payouts')
  async listPayouts(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payoutService.listPayouts(admin.sub, id);
  }

  @Put(':id/payouts/:pid/mark-paid')
  async markPayoutPaid(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) poolId: string,
    @Param('pid', ParseUUIDPipe) payoutId: string,
    @Body() dto: MarkRefundedDto,
  ) {
    return this.payoutService.markPayoutPaid(
      admin.sub,
      poolId,
      payoutId,
      dto.binance_tx_id,
      dto.notes,
    );
  }

  @Put(':id/cancel')
  async cancelPool(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payoutService.cancelPool(admin.sub, id);
  }

  // ── Transaction Tracking & Auditing ──

  @Get(':poolId/transactions')
  async listTransactions(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Query('status') status?: string,
    @Query('transactionType') transactionType?: string,
    @Query('userId') userId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionsService.listTransactions(admin.sub, poolId, {
      status,
      transactionType,
      userId,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':poolId/transactions/:txId')
  async getTransactionDetail(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Param('txId', ParseUUIDPipe) txId: string,
  ) {
    return this.transactionsService.getTransactionDetail(admin.sub, poolId, txId);
  }

  @Get(':poolId/transactions-by-user')
  async listTransactionsByUser(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
  ) {
    return this.transactionsService.listTransactionsByUser(admin.sub, poolId);
  }

  @Get(':poolId/pending-actions')
  async getPendingActions(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
  ) {
    return this.transactionsService.getPendingActions(admin.sub, poolId);
  }
}
