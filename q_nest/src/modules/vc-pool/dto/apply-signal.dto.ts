import { IsUUID } from 'class-validator';

export class ApplySignalDto {
  @IsUUID()
  signal_id: string;
}
