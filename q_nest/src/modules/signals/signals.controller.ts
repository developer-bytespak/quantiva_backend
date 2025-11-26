import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { SignalsService } from './signals.service';

@Controller('signals')
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  @Get()
  findAll(@Query('strategyId') strategyId?: string, @Query('userId') userId?: string) {
    if (strategyId) {
      return this.signalsService.findByStrategy(strategyId);
    }
    if (userId) {
      return this.signalsService.findByUser(userId);
    }
    return this.signalsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.signalsService.findOne(id);
  }

  @Post()
  create(@Body() createSignalDto: any) {
    return this.signalsService.create(createSignalDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateSignalDto: any) {
    return this.signalsService.update(id, updateSignalDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.signalsService.delete(id);
  }

  @Post(':id/details')
  createDetail(@Param('id') id: string, @Body() detailDto: any) {
    return this.signalsService.createDetail(id, detailDto);
  }

  @Post(':id/explanations')
  createExplanation(@Param('id') id: string, @Body() explanationDto: any) {
    return this.signalsService.createExplanation(id, explanationDto);
  }
}

