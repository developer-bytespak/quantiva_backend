import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class UploadDocumentDto {
  @IsNotEmpty()
  @IsString()
  document_type?: string; // passport, id_card, drivers_license
}

