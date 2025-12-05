import { Controller, Get, Post, Put, Delete, Patch, Body, Param, UseGuards, HttpCode, HttpStatus, HttpException, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { UpdatePersonalInfoDto } from './dto/update-personal-info.dto';
import { CloudinaryService } from './services/cloudinary.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

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

  @Post('me/profile-picture')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
    },
  }))
  @HttpCode(HttpStatus.OK)
  async uploadProfilePicture(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: TokenPayload,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only JPEG, PNG, WebP, and GIF images are allowed.');
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024; // 5MB in bytes
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 5MB limit.');
    }

    try {
      // Upload to Cloudinary
      const imageUrl = await this.cloudinaryService.uploadImage(file);

      // Update user's profile picture URL in database
      const updatedUser = await this.usersService.updateProfilePicture(user.sub, imageUrl);

      return {
        imageUrl,
        profile_pic_url: updatedUser.profile_pic_url,
      };
    } catch (error) {
      throw new HttpException(
        'Failed to upload profile picture',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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

