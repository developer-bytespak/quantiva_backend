import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  note: string;
}
