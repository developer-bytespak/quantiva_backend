import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AffiliateTokenPayload } from '../services/affiliate-token.service';

export type CurrentAffiliatePayload = AffiliateTokenPayload & {
  status: string;
};

export const CurrentAffiliate = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): CurrentAffiliatePayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as CurrentAffiliatePayload;
  },
);
