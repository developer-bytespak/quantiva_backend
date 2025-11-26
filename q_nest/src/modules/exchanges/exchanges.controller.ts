import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { ExchangesService } from './exchanges.service';

@Controller('exchanges')
export class ExchangesController {
  constructor(private readonly exchangesService: ExchangesService) {}

  @Get()
  findAll() {
    return this.exchangesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.exchangesService.findOne(id);
  }

  @Get('connections/:userId')
  getUserConnections(@Param('userId') userId: string) {
    return this.exchangesService.getUserConnections(userId);
  }

  @Post()
  create(@Body() createExchangeDto: any) {
    return this.exchangesService.create(createExchangeDto);
  }

  @Post('connections')
  createConnection(@Body() createConnectionDto: any) {
    return this.exchangesService.createConnection(createConnectionDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateExchangeDto: any) {
    return this.exchangesService.update(id, updateExchangeDto);
  }

  @Put('connections/:id')
  updateConnection(@Param('id') id: string, @Body() updateConnectionDto: any) {
    return this.exchangesService.updateConnection(id, updateConnectionDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.exchangesService.delete(id);
  }

  @Delete('connections/:id')
  removeConnection(@Param('id') id: string) {
    return this.exchangesService.deleteConnection(id);
  }
}

