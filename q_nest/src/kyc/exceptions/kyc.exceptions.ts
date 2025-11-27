import { HttpException, HttpStatus } from '@nestjs/common';

export class VerificationFailedException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class DocumentInvalidException extends HttpException {
  constructor(message: string = 'Invalid document provided') {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class LivenessCheckFailedException extends HttpException {
  constructor(message: string = 'Liveness check failed') {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class FaceMatchFailedException extends HttpException {
  constructor(message: string = 'Face match failed') {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

export class KycVerificationNotFoundException extends HttpException {
  constructor(message: string = 'KYC verification not found') {
    super(message, HttpStatus.NOT_FOUND);
  }
}

export class KycAlreadyApprovedException extends HttpException {
  constructor(message: string = 'KYC verification already approved') {
    super(message, HttpStatus.BAD_REQUEST);
  }
}

