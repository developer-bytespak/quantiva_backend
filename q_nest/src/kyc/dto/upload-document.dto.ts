import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';

export class UploadDocumentDto {
  @IsNotEmpty()
  @IsString()
  document_type?: string; // passport, id_card, drivers_license

  @IsOptional()
  @IsString()
  @IsIn(['front', 'back'], { message: 'document_side must be either "front" or "back"' })
  document_side?: string; // 'front' | 'back' - for multi-sided documents
}

