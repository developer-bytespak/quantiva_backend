import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeleteAffiliateDto {
  /**
   * Optional safety check — when supplied, the service requires it to match
   * the affiliate's display_name exactly before deleting. The frontend uses
   * this for the "type the display name to confirm" pattern.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  confirm_display_name?: string;
}
