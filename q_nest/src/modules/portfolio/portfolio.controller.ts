import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller('portfolios')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get()
  findAll(@Query('userId') userId?: string) {
    if (userId) {
      return this.portfolioService.findByUser(userId);
    }
    return this.portfolioService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.portfolioService.findOne(id);
  }

  @Post()
  create(@Body() createPortfolioDto: any) {
    return this.portfolioService.create(createPortfolioDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updatePortfolioDto: any) {
    return this.portfolioService.update(id, updatePortfolioDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.portfolioService.delete(id);
  }

  @Post(':id/positions')
  createPosition(@Param('id') id: string, @Body() positionDto: any) {
    return this.portfolioService.createPosition(id, positionDto);
  }

  @Put('positions/:positionId')
  updatePosition(@Param('positionId') positionId: string, @Body() positionDto: any) {
    return this.portfolioService.updatePosition(positionId, positionDto);
  }

  @Delete('positions/:positionId')
  removePosition(@Param('positionId') positionId: string) {
    return this.portfolioService.deletePosition(positionId);
  }

  @Post(':id/snapshots')
  createSnapshot(@Param('id') id: string, @Body() snapshotDto: any) {
    return this.portfolioService.createSnapshot(id, snapshotDto);
  }
}

