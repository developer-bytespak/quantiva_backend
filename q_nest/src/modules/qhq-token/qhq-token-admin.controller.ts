import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QhqTokenService } from './qhq-token.service';
import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import { AdminGrantDeductDto, UpdateRewardRuleDto } from './dto/spend-qhq.dto';

@Controller('admin/qhq')
@UseGuards(AdminJwtAuthGuard)
export class QhqTokenAdminController {
  constructor(private readonly qhqService: QhqTokenService) {}

  /** GET /admin/qhq/stats — token supply, holders, burned stats */
  @Get('stats')
  async getStats() {
    return this.qhqService.getTokenStats();
  }

  /** POST /admin/qhq/grant — manually grant QHQ to a user */
  @Post('grant')
  @HttpCode(HttpStatus.OK)
  async grantTokens(@Body() dto: AdminGrantDeductDto) {
    return this.qhqService.adminGrantTokens(dto.user_id, dto.amount, dto.description);
  }

  /** POST /admin/qhq/deduct — manually deduct QHQ from a user */
  @Post('deduct')
  @HttpCode(HttpStatus.OK)
  async deductTokens(@Body() dto: AdminGrantDeductDto) {
    return this.qhqService.adminDeductTokens(dto.user_id, dto.amount, dto.description);
  }

  /** POST /admin/qhq/update-merkle-root — trigger Merkle root regeneration + on-chain update */
  @Post('update-merkle-root')
  @HttpCode(HttpStatus.OK)
  async updateMerkleRoot() {
    const txHash = await this.qhqService.generateAndUpdateMerkleRoot();
    return { success: true, tx_hash: txHash };
  }

  /** GET /admin/qhq/reward-rules — list all reward rules */
  @Get('reward-rules')
  async getRewardRules() {
    return this.qhqService.getRewardRules();
  }

  /** PATCH /admin/qhq/reward-rules/:key — update a reward rule */
  @Patch('reward-rules/:key')
  async updateRewardRule(@Param('key') key: string, @Body() dto: UpdateRewardRuleDto) {
    return this.qhqService.updateRewardRule(key, {
      amount: dto.amount,
      is_active: dto.is_active,
      description: dto.description,
    });
  }
}
