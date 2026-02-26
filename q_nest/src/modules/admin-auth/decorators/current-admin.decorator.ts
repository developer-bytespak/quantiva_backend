import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminTokenPayload } from '../services/admin-token.service';

export const CurrentAdmin = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AdminTokenPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AdminTokenPayload;
  },
);
