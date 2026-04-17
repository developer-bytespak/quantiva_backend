import { IsIn, IsString } from 'class-validator';

export type DeleteReason = 'final_rejection' | 'voluntary';

export class DeleteSelfDto {
  @IsString()
  @IsIn(['final_rejection', 'voluntary'])
  reason: DeleteReason;
}
