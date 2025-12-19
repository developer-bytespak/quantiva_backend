import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { SignalsService } from './signals.service';
import { LLMExplanationProcessorService } from '../strategies/services/llm-explanation-processor.service';

@Controller('signals')
export class SignalsController {
  constructor(
    private readonly signalsService: SignalsService,
    private readonly llmProcessor: LLMExplanationProcessorService,
  ) {}

  @Get()
  async findAll(
    @Query('strategyId') strategyId?: string,
    @Query('userId') userId?: string,
    @Query('latest_only') latestOnly?: string,
    @Query('limit') limit?: string,
    @Query('realtime') realtime?: string,
  ) {
    const latest = latestOnly === 'true' || latestOnly === '1';
    const cap = limit ? Number(limit) : undefined;
    const enrichWithRealtime = realtime === 'true' || realtime === '1';

    if (latest) {
      return this.signalsService.findLatestSignals({ 
        strategyId, 
        userId, 
        limit: cap,
        enrichWithRealtime,
      });
    }

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

  @Post(':id/explain')
  async explainSignal(@Param('id') id: string) {
    // Non-throwing endpoint: attempt to (re)generate LLM explanation for a signal
    try {
      await this.llmProcessor.generateExplanation(id);
      const signal = await this.signalsService.findOne(id);
      const explanation = signal?.explanations?.[0] || null;
      return { success: true, explanation };
    } catch (error: any) {
      // Return structured failure with any existing explanation record
      const signal = await this.signalsService.findOne(id);
      const explanation = signal?.explanations?.[0] || null;
      return { success: false, error: error?.message || String(error), explanation };
    }
  }
}

