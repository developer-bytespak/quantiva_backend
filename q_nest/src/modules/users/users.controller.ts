import { Controller, Get, Post, Put, Delete, Patch, Body, Param, UseGuards, HttpCode, HttpStatus, HttpException } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { UpdatePersonalInfoDto } from './dto/update-personal-info.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Specific routes must come before parameterized routes
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getCurrentUser(@CurrentUser() user: TokenPayload) {
    return this.usersService.getCurrentUserProfile(user.sub);
  }

  @Patch('me/personal-info')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateCurrentUserPersonalInfo(
    @Body() updatePersonalInfoDto: UpdatePersonalInfoDto,
    @CurrentUser() user: TokenPayload,
  ) {
    return this.usersService.updatePersonalInfo(user.sub, updatePersonalInfoDto);
  }

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Post()
  create(@Body() createUserDto: any) {
    return this.usersService.create(createUserDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateUserDto: any) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.delete(id);
  }

  @Patch(':id/personal-info')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updatePersonalInfo(
    @Param('id') id: string,
    @Body() updatePersonalInfoDto: UpdatePersonalInfoDto,
    @CurrentUser() user: TokenPayload,
  ) {
    // Ensure user can only update their own personal info
    if (user.sub !== id) {
      throw new HttpException('Unauthorized: You can only update your own personal information', HttpStatus.FORBIDDEN);
    }
    return this.usersService.updatePersonalInfo(id, updatePersonalInfoDto);
  }
}

