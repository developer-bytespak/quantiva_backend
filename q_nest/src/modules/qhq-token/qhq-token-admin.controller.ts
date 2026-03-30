import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { QhqTokenService } from './qhq-token.service';
import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import { AdminGrantDeductDto, UpdateRewardRuleDto } from './dto/spend-qhq.dto';

@Controller('admin/qhq')
@UseGuards(AdminJwtAuthGuard)
export class QhqTokenAdminController {
  constructor(private readonly qhqService: QhqTokenService) {}

  /** GET /admin/qhq/stats — token supply, holders, burned */
  @Get('stats')
  async getStats() {
    return this.qhqService.getTokenStats();
  }

  /** POST /admin/qhq/grant — manually grant QHQ to a user */
  @Post('grant')
  async grantTokens(@Body() dto: AdminGrantDeductDto) {
    return this.qhqService.adminGrantTokens(dto.user_id, dto.amount, dto.description);
  }

  /** POST /admin/qhq/deduct — manually deduct QHQ from a user */
  @Post('deduct')
  async deductTokens(@Body() dto: AdminGrantDeductDto) {
    return this.qhqService.adminDeductTokens(dto.user_id, dto.amount, dto.description);
  }

  /** POST /admin/qhq/update-merkle-root — trigger Merkle root update */
  @Post('update-merkle-root')
  async updateMerkleRoot() {
    return this.qhqService.generateAndUpdateMerkleRoot();
  }

  /** GET /admin/qhq/reward-rules — list all reward rules */
  @Get('reward-rules')
  async getRewardRules() {
    return this.qhqService.getRewardRules();
  }

  /** PATCH /admin/qhq/reward-rules/:key — update a specific reward rule */
  @Patch('reward-rules/:key')
  async updateRewardRule(
    @Param('key') key: string,
    @Body() dto: UpdateRewardRuleDto,
  ) {
    return this.qhqService.updateRewardRule(key, dto);
  }
}
