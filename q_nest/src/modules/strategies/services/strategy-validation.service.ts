import { Injectable, BadRequestException } from '@nestjs/common';
import { CreateStrategyDto, ValidateStrategyDto, EntryRuleDto, ExitRuleDto } from '../dto/create-strategy.dto';

@Injectable()
export class StrategyValidationService {
  private readonly validIndicators = [
    'MA20',
    'MA50',
    'MA200',
    'RSI',
    'MACD',
    'ATR',
    'BB',
    'STOCH',
    'ADX',
    'CCI',
    'OBV',
    'VOLUME',
    // allow using the aggregated final score as a rule indicator
    'final_score',
  ];

  // Valid field paths for score-based rules (like pre-built strategies)
  private readonly validFields = [
    'final_score',
    'metadata.engine_details.sentiment.score',
    'metadata.engine_details.trend.score',
    'metadata.engine_details.fundamental.score',
    'metadata.engine_details.event_risk.score',
    'metadata.engine_details.liquidity.score',
  ];

  private readonly validOperators = [
    '>',
    '<',
    '>=',
    '<=',
    '==',
    '!=',
    'cross_above',
    'cross_below',
  ];

  private readonly validTimeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

  private readonly validStopLossTypes = ['percentage', 'atr', 'fixed'];
  private readonly validTakeProfitTypes = ['percentage', 'ratio', 'fixed'];

  /**
   * Validate a complete strategy
   */
  async validateStrategy(dto: CreateStrategyDto | ValidateStrategyDto): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    // Validate entry rules
    if ('entry_rules' in dto && dto.entry_rules) {
      const entryErrors = this.validateRules(dto.entry_rules, 'entry');
      errors.push(...entryErrors);
    }

    // Validate exit rules
    if ('exit_rules' in dto && dto.exit_rules) {
      const exitErrors = this.validateRules(dto.exit_rules, 'exit');
      errors.push(...exitErrors);
    }

    // Validate indicators (optional — allow empty array)
    if ('indicators' in dto && dto.indicators) {
      const indicatorErrors = this.validateIndicators(dto.indicators);
      errors.push(...indicatorErrors);
    }

    // Validate timeframe
    if ('timeframe' in dto && dto.timeframe) {
      if (!this.validTimeframes.includes(dto.timeframe)) {
        errors.push(
          `Invalid timeframe: ${dto.timeframe}. Valid timeframes: ${this.validTimeframes.join(', ')}`,
        );
      }
    }

    // Validate stop loss
    if ('stop_loss_type' in dto && dto.stop_loss_type) {
      if (!this.validStopLossTypes.includes(dto.stop_loss_type)) {
        errors.push(
          `Invalid stop_loss_type: ${dto.stop_loss_type}. Valid types: ${this.validStopLossTypes.join(', ')}`,
        );
      }
      if (dto.stop_loss_value !== undefined) {
        if (dto.stop_loss_value < 0 || dto.stop_loss_value > 100) {
          errors.push('stop_loss_value must be between 0 and 100');
        }
      }
    }

    // Validate take profit
    if ('take_profit_type' in dto && dto.take_profit_type) {
      if (!this.validTakeProfitTypes.includes(dto.take_profit_type)) {
        errors.push(
          `Invalid take_profit_type: ${dto.take_profit_type}. Valid types: ${this.validTakeProfitTypes.join(', ')}`,
        );
      }
      if ('take_profit_value' in dto && dto.take_profit_value !== undefined) {
        if (dto.take_profit_value < 0) {
          errors.push('take_profit_value must be positive');
        }
      }
    }

    // Validate cron expression
    if ('schedule_cron' in dto && dto.schedule_cron) {
      const cronError = this.validateCronExpression(dto.schedule_cron);
      if (cronError) {
        errors.push(cronError);
      }
    }

    // Validate target assets (allow empty array at creation; activation requires non-empty)
    if ('target_assets' in dto) {
      if (!Array.isArray(dto.target_assets)) {
        errors.push('target_assets must be an array');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate entry or exit rules
   * Supports both indicator-based rules (legacy) and field-based rules (new score-based)
   */
  private validateRules(
    rules: Array<EntryRuleDto | ExitRuleDto>,
    ruleType: 'entry' | 'exit',
  ): string[] {
    const errors: string[] = [];

    if (!Array.isArray(rules) || rules.length === 0) {
      // Allow empty rules for field-based strategies (they use engine_weights instead)
      return errors;
    }

    rules.forEach((rule, index) => {
      // Check if rule uses field-based or indicator-based format
      const hasField = 'field' in rule && rule.field;
      const hasIndicator = 'indicator' in rule && rule.indicator;

      if (!hasField && !hasIndicator) {
        errors.push(
          `${ruleType} rule ${index + 1}: Must have either 'indicator' or 'field' property`,
        );
        return;
      }

      // Validate field-based rule
      if (hasField) {
        if (!this.validFields.includes(rule.field!)) {
          errors.push(
            `${ruleType} rule ${index + 1}: Invalid field '${rule.field}'. Valid fields: ${this.validFields.join(', ')}`,
          );
        }
      }

      // Validate indicator-based rule
      if (hasIndicator) {
        if (!this.validIndicators.includes(rule.indicator!)) {
          errors.push(
            `${ruleType} rule ${index + 1}: Invalid indicator '${rule.indicator}'. Valid indicators: ${this.validIndicators.join(', ')}`,
          );
        }
      }

      // Validate operator
      if (!rule.operator || !this.validOperators.includes(rule.operator)) {
        errors.push(
          `${ruleType} rule ${index + 1}: Invalid operator '${rule.operator}'. Valid operators: ${this.validOperators.join(', ')}`,
        );
      }

      // Validate value
      if (rule.value === undefined || rule.value === null || isNaN(rule.value)) {
        errors.push(`${ruleType} rule ${index + 1}: value is required and must be a number`);
      }

      // Validate timeframe if provided
      if (rule.timeframe && !this.validTimeframes.includes(rule.timeframe)) {
        errors.push(
          `${ruleType} rule ${index + 1}: Invalid timeframe '${rule.timeframe}'. Valid timeframes: ${this.validTimeframes.join(', ')}`,
        );
      }
    });

    return errors;
  }

  /**
   * Validate indicators configuration
   */
  private validateIndicators(
    indicators: Array<{ name: string; parameters?: Record<string, any>; timeframe?: string }>,
  ): string[] {
    const errors: string[] = [];

    if (!Array.isArray(indicators)) {
      errors.push('indicators must be an array');
      return errors;
    }
    // allow empty indicators array at creation time
    if (indicators.length === 0) {
      return errors;
    }

    indicators.forEach((indicator, index) => {
      // Validate indicator name
      if (!indicator.name || !this.validIndicators.includes(indicator.name)) {
        errors.push(
          `Indicator ${index + 1}: Invalid name '${indicator.name}'. Valid indicators: ${this.validIndicators.join(', ')}`,
        );
      }

      // Validate timeframe if provided
      if (indicator.timeframe && !this.validTimeframes.includes(indicator.timeframe)) {
        errors.push(
          `Indicator ${index + 1}: Invalid timeframe '${indicator.timeframe}'. Valid timeframes: ${this.validTimeframes.join(', ')}`,
        );
      }

      // Validate parameters based on indicator type
      if (indicator.parameters) {
        const paramErrors = this.validateIndicatorParameters(indicator.name, indicator.parameters);
        errors.push(...paramErrors.map((e) => `Indicator ${index + 1}: ${e}`));
      }
    });

    return errors;
  }

  /**
   * Validate indicator-specific parameters
   */
  private validateIndicatorParameters(
    indicatorName: string,
    parameters: Record<string, any>,
  ): string[] {
    const errors: string[] = [];

    switch (indicatorName) {
      case 'RSI':
        if (parameters.period !== undefined && (parameters.period < 1 || parameters.period > 100)) {
          errors.push('RSI period must be between 1 and 100');
        }
        break;

      case 'MACD':
        if (parameters.fast !== undefined && (parameters.fast < 1 || parameters.fast > 50)) {
          errors.push('MACD fast period must be between 1 and 50');
        }
        if (parameters.slow !== undefined && (parameters.slow < 1 || parameters.slow > 100)) {
          errors.push('MACD slow period must be between 1 and 100');
        }
        if (parameters.signal !== undefined && (parameters.signal < 1 || parameters.signal > 20)) {
          errors.push('MACD signal period must be between 1 and 20');
        }
        break;

      case 'ATR':
        if (parameters.period !== undefined && (parameters.period < 1 || parameters.period > 50)) {
          errors.push('ATR period must be between 1 and 50');
        }
        break;

      case 'MA20':
      case 'MA50':
      case 'MA200':
        // Moving averages don't typically need parameters
        break;

      default:
        // Other indicators - basic validation
        break;
    }

    return errors;
  }

  /**
   * Validate cron expression
   */
  private validateCronExpression(cron: string): string | null {
    // Basic cron validation (5 or 6 fields)
    const cronParts = cron.trim().split(/\s+/);
    
    if (cronParts.length < 5 || cronParts.length > 6) {
      return `Invalid cron expression. Must have 5 or 6 fields, got ${cronParts.length}`;
    }

    // Validate each field (simplified validation)
    const validPattern = /^[\d\*\/\-\,]+$/;
    for (let i = 0; i < cronParts.length; i++) {
      if (!validPattern.test(cronParts[i])) {
        return `Invalid cron expression. Field ${i + 1} contains invalid characters`;
      }
    }

    return null;
  }

  /**
   * Parse strategy rules into structured format
   */
  parseStrategyRules(dto: CreateStrategyDto): {
    entry_rules: any;
    exit_rules: any;
    indicators: any;
  } {
    return {
      entry_rules: dto.entry_rules,
      exit_rules: dto.exit_rules,
      indicators: dto.indicators,
    };
  }
}

