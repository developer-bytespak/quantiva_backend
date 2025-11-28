import { HttpException, HttpStatus } from '@nestjs/common';

export class InvalidApiKeyException extends HttpException {
  constructor(message = 'Invalid API key or secret') {
    super(
      {
        code: 'INVALID_API_KEY',
        message,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class BinanceRateLimitException extends HttpException {
  constructor(message = 'Binance API rate limit exceeded. Please try again later.') {
    super(
      {
        code: 'RATE_LIMIT_EXCEEDED',
        message,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class BinanceApiException extends HttpException {
  constructor(message: string, code?: string) {
    super(
      {
        code: code || 'BINANCE_API_ERROR',
        message,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}

export class ConnectionNotFoundException extends HttpException {
  constructor(message = 'Connection not found') {
    super(
      {
        code: 'CONNECTION_NOT_FOUND',
        message,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

