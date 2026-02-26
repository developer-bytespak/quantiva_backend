import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PoolManagementService } from '../services/pool-management.service';
import { AdminJwtAuthGuard } from '../../admin-auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../admin-auth/decorators/current-admin.decorator';
import { AdminTokenPayload } from '../../admin-auth/services/admin-token.service';
import { CreatePoolDto } from '../dto/create-pool.dto';
import { UpdatePoolDto } from '../dto/update-pool.dto';

@Controller('admin/pools')
@UseGuards(AdminJwtAuthGuard)
export class AdminPoolController {
  constructor(private readonly poolService: PoolManagementService) {}

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
}
