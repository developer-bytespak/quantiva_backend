import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { DeleteVcPoolAdminDto } from '../dto/delete-vc-pool-admin.dto';
import { CreateVcPoolAdminDto } from '../dto/create-vc-pool-admin.dto';
import { SuperAdminListUsersDto } from '../dto/super-admin-list-users.dto';
import { SuperAdminUsersGrowthDto } from '../dto/super-admin-users-growth.dto';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { AdminTokenPayload } from '../services/admin-token.service';
import { SuperAdminManagementService } from '../services/super-admin-management.service';

@Controller('admin/super-admin')
@UseGuards(AdminJwtAuthGuard, SuperAdminGuard)
export class SuperAdminManagementController {
  constructor(
    private readonly superAdminManagementService: SuperAdminManagementService,
  ) {}

  @Get('users')
  async listUsers(@Query() query: SuperAdminListUsersDto) {
    return this.superAdminManagementService.listUsers(query);
  }

  @Get('users/analytics')
  async usersAnalytics() {
    return this.superAdminManagementService.usersAnalytics();
  }

  @Get('users/growth')
  async usersGrowth(@Query() query: SuperAdminUsersGrowthDto) {
    return this.superAdminManagementService.usersGrowthByMonth(query);
  }

  @Get('vc-pool-admins')
  async listVcPoolAdmins() {
    return this.superAdminManagementService.listVcPoolAdmins();
  }

  @Post('vc-pool-admins')
  async createVcPoolAdmin(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: CreateVcPoolAdminDto,
  ) {
    return this.superAdminManagementService.createVcPoolAdmin(admin.sub, dto);
  }

  @Delete('vc-pool-admins/:adminId')
  async deleteVcPoolAdmin(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('adminId', ParseUUIDPipe) adminId: string,
    @Body() dto: DeleteVcPoolAdminDto,
  ) {
    return this.superAdminManagementService.deleteVcPoolAdmin(
      admin.sub,
      adminId,
      dto.currentPassword,
    );
  }
}
