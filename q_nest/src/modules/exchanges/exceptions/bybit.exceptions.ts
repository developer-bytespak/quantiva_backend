import { HttpException, HttpStatus } from '@nestjs/common';

export class BybitInvalidApiKeyException extends HttpException {
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

export class BybitRateLimitException extends HttpException {
  constructor(message = 'Bybit API rate limit exceeded. Please try again later.') {
    super(
      {
        code: 'RATE_LIMIT_EXCEEDED',
        message,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class BybitApiException extends HttpException {
  constructor(message: string, code?: string) {
    super(
      {
        code: code || 'BYBIT_API_ERROR',
        message,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}

