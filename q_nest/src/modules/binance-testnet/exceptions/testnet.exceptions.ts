import { HttpException, HttpStatus } from '@nestjs/common';

export class TestnetApiException extends HttpException {
  constructor(
    message: string,
    statusCode: number = HttpStatus.BAD_REQUEST,
  ) {
    super(
      {
        statusCode,
        message,
        error: 'TestnetApiException',
      },
      statusCode,
    );
  }
}

export class TestnetConnectionException extends HttpException {
  constructor(message: string = 'Failed to connect to Binance Testnet') {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message,
        error: 'TestnetConnectionException',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export class InvalidTestnetApiKeyException extends HttpException {
  constructor(message: string = 'Invalid API key or secret for Binance Testnet') {
    super(
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message,
        error: 'InvalidTestnetApiKeyException',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class TestnetRateLimitException extends HttpException {
  constructor(message: string = 'Rate limit exceeded on Binance Testnet') {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        error: 'TestnetRateLimitException',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class TestnetConnectionNotFoundException extends HttpException {
  constructor(message: string = 'Testnet connection not found') {
    super(
      {
        statusCode: HttpStatus.NOT_FOUND,
        message,
        error: 'TestnetConnectionNotFoundException',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
