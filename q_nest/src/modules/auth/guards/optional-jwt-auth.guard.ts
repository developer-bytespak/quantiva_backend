import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    // Do not block anonymous traffic; attach user only when token is valid.
    if (err || !user) {
      return null;
    }
    return user;
  }
}