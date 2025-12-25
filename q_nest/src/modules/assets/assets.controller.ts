import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { AssetsSyncCronjobService } from './assets-sync-cronjob.service';

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly assetsSyncCronjobService: AssetsSyncCronjobService,
  ) {}

  @Get()
  findAll() {
    return this.assetsService.findAll();
  }

  @Get('trending')
  getTrending() {
    return this.assetsService.getTrendingAssets();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.assetsService.findOne(id);
  }

  @Get(':id/market-data')
  getMarketData(
    @Param('id') id: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.assetsService.getMarketData(
      id,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  @Post()
  create(@Body() createAssetDto: any) {
    return this.assetsService.create(createAssetDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateAssetDto: any) {
    return this.assetsService.update(id, updateAssetDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.assetsService.delete(id);
  }

  @Post('sync-coingecko')
  async syncFromCoinGecko() {
    return this.assetsSyncCronjobService.manualSync();
  }

  @Get('sync-status')
  getSyncStatus() {
    return this.assetsSyncCronjobService.getSyncStatus();
  }
}

