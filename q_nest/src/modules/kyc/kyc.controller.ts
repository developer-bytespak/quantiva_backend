import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { KycService } from './kyc.service';

@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Get()
  findAll(@Query('userId') userId?: string) {
    if (userId) {
      return this.kycService.findByUser(userId);
    }
    return this.kycService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.kycService.findOne(id);
  }

  @Post()
  create(@Body() createKycDto: any) {
    return this.kycService.create(createKycDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateKycDto: any) {
    return this.kycService.update(id, updateKycDto);
  }

  @Post(':id/documents')
  createDocument(@Param('id') id: string, @Body() documentDto: any) {
    return this.kycService.createDocument(id, documentDto);
  }

  @Post(':id/face-matches')
  createFaceMatch(@Param('id') id: string, @Body() faceMatchDto: any) {
    return this.kycService.createFaceMatch(id, faceMatchDto);
  }
}

