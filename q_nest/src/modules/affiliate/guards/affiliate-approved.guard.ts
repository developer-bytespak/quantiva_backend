import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

@Injectable()
export class AffiliateApprovedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const affiliate = request.user as { status?: string } | undefined;

    if (affiliate?.status !== 'APPROVED') {
      throw new ForbiddenException(
        'Affiliate account is not approved for this resource',
      );
    }

    return true;
  }
}
