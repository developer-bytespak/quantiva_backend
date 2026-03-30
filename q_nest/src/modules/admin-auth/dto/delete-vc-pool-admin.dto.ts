import { IsNotEmpty, IsString } from 'class-validator';

export class DeleteVcPoolAdminDto {
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  currentPassword: string;
}
